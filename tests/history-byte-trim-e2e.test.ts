/**
 * The byte-trimmed collapse, through `transformRequest`.
 *
 * `tests/history-byte-trim.test.ts` pins the cut itself. This file pins the wiring:
 * both call sites hand the collapse the headroom they have left, the request that
 * leaves stays under both ceilings, and the telemetry says which one bit.
 *
 * There are two ceilings, and they fail differently:
 *
 *  - IMAGE WEIGHT (`maxImageBytes`), empirical, carried over from #157/#201;
 *  - WIRE SIZE (`maxWireBytes`), measured on this fork's production traffic
 *    2026-08-11 … 09-29: every one of 1,219 requests between 24 and 32 MiB
 *    returned 200, every one of 24 requests at 32.05 MiB and above returned 413.
 *    An 18 MiB image budget is 24 MiB of base64, so a collapse that fills it on top
 *    of a large text body turns a request that worked into one that cannot.
 *
 * Run just this file:  pnpm vitest run tests/history-byte-trim-e2e.test.ts
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { transformRequest } from '../src/core/transform.js';
import { resetSessionState } from '../src/core/session-state.js';
import { toTrackEvent } from '../src/core/tracker.js';
import type { Message } from '../src/core/types.js';

const WORDS = [
  'order', 'window', 'latency', 'buffer', 'ledger', 'margin', 'signal', 'replay',
  'socket', 'cursor', 'bucket', 'stream', 'anchor', 'digest', 'format', 'kernel',
  'packet', 'review', 'series', 'thread', 'update', 'vector', 'worker', 'zone',
  'because', 'therefore', 'measured', 'against', 'before', 'after', 'never', 'always',
];

/** Deterministic, different per seed, and made of words: PNG weight has to follow
 *  the content or a byte budget has nothing to bite on. */
function prose(seed: number, chars: number): string {
  let s = (Math.imul(seed + 1, 2654435761) + 12345) >>> 0;
  const out: string[] = [];
  let len = 0;
  while (len < chars) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const w = WORDS[s % WORDS.length]! + (s % 7 === 0 ? ` ${s % 9973}` : '');
    out.push(w);
    len += w.length + 1;
  }
  return out.join(' ').slice(0, chars);
}

const enc = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));
const dec = (b: Uint8Array): any => JSON.parse(new TextDecoder().decode(b));

/**
 * A tool-using session with a closed boundary every four messages. Tool results
 * stay under the per-block imaging threshold, so the only images in play are the
 * slab and the collapsed history.
 */
function session(rounds: number): Message[] {
  const out: Message[] = [{ role: 'user', content: 'start the review' }];
  for (let i = 0; i < rounds; i++) {
    out.push(
      {
        role: 'assistant',
        content: [
          { type: 'text', text: `reading file ${i}` },
          { type: 'tool_use', id: `tu${i}`, name: 'Read', input: { path: `/f/${i}` } },
        ],
      } as unknown as Message,
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: `tu${i}`, content: `RESULT ${i}\n` + prose(i, 3000) },
        ],
      } as unknown as Message,
      { role: 'assistant', content: `note ${i}: ` + prose(1000 + i, 600) },
      { role: 'user', content: `continue with ${i + 1}` },
    );
  }
  return out;
}

/** `slabChars` of 0 sends the request down the early-exit path, where the slab
 *  is not imaged and the collapse runs from `runHistoryCollapseAndFinalize`. */
function request(messages: Message[], slabChars: number, model = 'claude-3-5-sonnet') {
  return enc({
    model,
    system: [{ type: 'text', text: slabChars > 0 ? 'SLAB\n' + prose(7, slabChars) : 'Be brief.' }],
    messages,
  });
}

/** Total decoded image bytes actually on the wire, at both nesting levels. */
function wireImageBytes(msgs: any[]): number {
  let total = 0;
  const add = (b: any): void => {
    if (b?.type === 'image' && typeof b.source?.data === 'string') {
      const d = b.source.data as string;
      const pad = d.endsWith('==') ? 2 : d.endsWith('=') ? 1 : 0;
      total += Math.floor((d.length * 3) / 4) - pad;
    }
  };
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      add(b);
      if (b?.type === 'tool_result' && Array.isArray(b.content)) for (const ib of b.content) add(ib);
    }
  }
  return total;
}

const UNLIMITED = { maxImageBytes: 2 ** 40, maxWireBytes: 2 ** 40 };

for (const [name, slabChars, head] of [
  ['main path (slab imaged)', 60_000, 1],
  ['early-exit path (slab stays text)', 0, 0],
] as const) {
  describe(`a history too heavy for the image budget — ${name}`, () => {
    beforeEach(() => resetSessionState());

    it('is collapsed in part instead of being refused whole', async () => {
      const msgs = session(40);
      const body = request(msgs, slabChars);
      const full = await transformRequest(body, UNLIMITED);
      expect(full.info.historyReason).toBe('collapsed');
      expect(full.info.historyByteTrimmed).toBeUndefined();

      resetSessionState();
      const limit = Math.floor(full.info.imageBytes * 0.6);
      const { body: out, info } = await transformRequest(body, {
        ...UNLIMITED,
        maxImageBytes: limit,
      });

      expect(info.historyReason).toBe('collapsed');
      expect(info.historyByteTrimmed).toBe(true);
      expect(info.collapsedTurns ?? 0).toBeGreaterThan(0);
      expect(info.collapsedTurns ?? 0).toBeLessThan(full.info.collapsedTurns ?? 0);
      // A trimmed collapse is a collapse. It is not also a skip.
      expect(info.imageByteSkips ?? 0).toBe(0);
      expect(info.wireBound).toBeUndefined();

      const wire = dec(out).messages as any[];
      expect(wireImageBytes(wire)).toBeLessThanOrEqual(limit);
      expect(wireImageBytes(wire)).toBe(info.imageBytes);
      // Everything behind the cut is on the wire as the caller sent it.
      expect(wire.slice(head + 1)).toEqual(msgs.slice(head + (info.collapsedTurns ?? 0)));
    });

    it('still reports a refusal as a byte skip when nothing fits', async () => {
      const msgs = session(40);
      const body = request(msgs, slabChars);
      const slabOnly = await transformRequest(
        request([{ role: 'user', content: 'start the review' }], slabChars),
        UNLIMITED,
      );
      resetSessionState();
      // Room for the slab and a few hundred bytes more: no chunk of history fits.
      const { body: out, info } = await transformRequest(body, {
        ...UNLIMITED,
        maxImageBytes: slabOnly.info.imageBytes + 500,
      });

      expect(info.historyReason).toBe('image_bytes');
      expect(info.historyByteTrimmed).toBeUndefined();
      expect(info.collapsedTurns ?? 0).toBe(0);
      expect(info.imageByteSkips ?? 0).toBeGreaterThan(0);
      expect(dec(out).messages.slice(head)).toEqual(msgs.slice(head));
    });
  });
}

describe('a collapse that would not fit on the wire', () => {
  beforeEach(() => resetSessionState());

  it('is trimmed so the serialized request stays under the wire ceiling', async () => {
    const msgs = session(40);
    const body = request(msgs, 60_000);
    const full = await transformRequest(body, UNLIMITED);
    // The premise: imaging makes this request heavier on the wire, not lighter.
    expect(full.body.length).toBeGreaterThan(body.length);

    resetSessionState();
    const maxWireBytes = body.length + Math.floor((full.body.length - body.length) / 2);
    const { body: out, info } = await transformRequest(body, { ...UNLIMITED, maxWireBytes });

    expect(out.length).toBeLessThanOrEqual(maxWireBytes);
    expect(info.historyReason).toBe('collapsed');
    expect(info.historyByteTrimmed).toBe(true);
    expect(info.wireBound).toBe(true);
    expect(info.collapsedTurns ?? 0).toBeGreaterThan(0);
    expect(info.collapsedTurns ?? 0).toBeLessThan(full.info.collapsedTurns ?? 0);
  });

  it('is trimmed on the early-exit path as well', async () => {
    const msgs = session(40);
    const body = request(msgs, 0);
    const full = await transformRequest(body, UNLIMITED);
    expect(full.body.length).toBeGreaterThan(body.length);

    resetSessionState();
    const maxWireBytes = body.length + Math.floor((full.body.length - body.length) / 2);
    const { body: out, info } = await transformRequest(body, { ...UNLIMITED, maxWireBytes });

    expect(out.length).toBeLessThanOrEqual(maxWireBytes);
    expect(info.historyReason).toBe('collapsed');
    expect(info.historyByteTrimmed).toBe(true);
  });

  it("does not charge the caller's own images twice", async () => {
    // The inbound size already contains them and the headroom deducts them, so
    // the limit has to carry them. Here the wire has room for every page the
    // collapse adds and nothing to spare: charged twice, the collapse is cut.
    const msgs = session(40);
    const b64Chars = Math.ceil(300_000 / 3) * 4;
    msgs[msgs.length - 1] = {
      role: 'user',
      content: [
        { type: 'text', text: 'continue with this screenshot' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(b64Chars) },
        },
      ],
    } as unknown as Message;
    const body = request(msgs, 0);
    const full = await transformRequest(body, UNLIMITED);
    expect(full.info.nativeImageBytes ?? 0).toBeGreaterThan(250_000);
    expect(full.info.historyReason).toBe('collapsed');

    resetSessionState();
    const maxWireBytes = body.length + Math.ceil((full.info.imageBytes * 4) / 3) + 64;
    const { body: out, info } = await transformRequest(body, { ...UNLIMITED, maxWireBytes });

    expect(info.wireBound).toBe(true);
    expect(info.historyReason).toBe('collapsed');
    expect(info.historyByteTrimmed).toBeUndefined();
    expect(info.collapsedTurns).toBe(full.info.collapsedTurns);
    expect(out.length).toBeLessThanOrEqual(maxWireBytes);
  });

  it('keeps the history as text when the inbound body already fills the wire', async () => {
    const msgs = session(40);
    const body = request(msgs, 0);
    const { body: out, info } = await transformRequest(body, {
      ...UNLIMITED,
      maxWireBytes: body.length,
    });

    expect(info.historyReason).toBe('image_bytes');
    expect(info.collapsedTurns ?? 0).toBe(0);
    expect(dec(out).messages).toEqual(msgs);
  });

  it('defaults to a ceiling under the 32 MiB the provider rejects at', async () => {
    // Not a behaviour test of a 30 MiB request: a guard that the default exists
    // and leaves a margin. Measured: smallest 413 at 32.05 MiB, largest 200 just
    // under 32. The margin covers what the estimate does not see, such as pins
    // appended after the collapse.
    const { DEFAULT_MAX_WIRE_BYTES } = await import('../src/core/transform.js');
    expect(DEFAULT_MAX_WIRE_BYTES).toBeLessThanOrEqual(31 * 1024 * 1024);
    expect(DEFAULT_MAX_WIRE_BYTES).toBeGreaterThanOrEqual(28 * 1024 * 1024);
  });
});

describe('telemetry names the trim', () => {
  it('emits history_byte_trimmed when the byte budget shortened the collapse', () => {
    const out = toTrackEvent({
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      durationMs: 5,
      info: {
        compressed: true,
        origChars: 1,
        historyReason: 'collapsed',
        historyByteTrimmed: true,
        wireBound: true,
      },
    });
    expect(out.history_byte_trimmed).toBe(true);
    expect(out.wire_bound).toBe(true);
  });

  it('omits it otherwise', () => {
    const out = toTrackEvent({
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      durationMs: 5,
      info: { compressed: true, origChars: 1, historyReason: 'collapsed' },
    });
    expect(out.history_byte_trimmed).toBeUndefined();
    expect(out.wire_bound).toBeUndefined();
  });
});
