/**
 * The partial collapse weighs more pages than it sends, and only the ones it sends
 * are worth encoding.
 *
 * Weighing a chunk means rendering it; whether it is admitted is known afterwards.
 * Base64 is the expensive half of a page that is already in the render cache:
 * measured at 37 ms per MiB (160 pages, 54 MiB: 2.0 s) against 20 ms to copy the
 * same pages out of the cache. A chunk that is weighed and put back must not pay it.
 *
 * Own file because the module mock below applies to everything in it.
 *
 * Run just this file:  pnpm vitest run tests/history-byte-trim-encode.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const encoded = vi.hoisted(() => ({ bytes: 0 }));

vi.mock('../src/core/png.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/png.js')>();
  return {
    ...real,
    // The real encoder, with a meter in front of it.
    bytesToBase64: (bytes: Uint8Array): string => {
      encoded.bytes += bytes.length;
      return real.bytesToBase64(bytes);
    },
  };
});

const { collapseHistory } = await import('../src/core/history.js');
const { clearRenderCache, renderCacheStats } = await import('../src/core/render.js');
type Message = import('../src/core/types.js').Message;

const WORDS = [
  'order', 'window', 'latency', 'buffer', 'ledger', 'margin', 'signal', 'replay',
  'socket', 'cursor', 'bucket', 'stream', 'anchor', 'digest', 'format', 'kernel',
  'packet', 'review', 'series', 'thread', 'update', 'vector', 'worker', 'zone',
  'because', 'therefore', 'measured', 'against', 'before', 'after', 'never', 'always',
];

/** Deterministic filler that differs per seed; real words, so that the weight of
 *  a page follows its content. */
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

function plainConvo(messages: number, chars = 1500): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages; i++) {
    out.push(
      i % 2 === 0
        ? { role: 'user', content: `question ${i}` }
        : { role: 'assistant', content: `answer ${i}: ` + prose(i, chars) },
    );
  }
  return out;
}

type Block = { type: string; source?: { data: string } };
const imagesOf = (m: Message | undefined): string[] =>
  Array.isArray(m?.content)
    ? (m!.content as unknown as Block[])
        .filter((b) => b.type === 'image')
        .map((b) => b.source!.data)
    : [];

const always = () => true;
const COARSE = { imageBudget: 0, minFreezeStep: 1280 } as const;

beforeEach(() => {
  clearRenderCache();
  encoded.bytes = 0;
});

describe('only what is sent is encoded', () => {
  it('encodes the pages it admits and none of the pages it weighed', async () => {
    const msgs = plainConvo(624);
    const full = await collapseHistory(msgs, always, COARSE);
    // The premise: the meter sees the encoder, at the weight of the pages.
    expect(encoded.bytes).toBe(full.info.collapsedImageBytes);

    const byteBudget = Math.floor(full.info.collapsedImageBytes / 4);
    clearRenderCache();
    encoded.bytes = 0;
    const { messages: out, info } = await collapseHistory(msgs, always, { ...COARSE, byteBudget });

    expect(info.byteTrimmed).toBe(true);
    // The premise of the case: more was weighed than was admitted.
    expect(renderCacheStats().bytes).toBeGreaterThan(info.collapsedImageBytes * 1.05);
    expect(encoded.bytes).toBe(info.collapsedImageBytes);
    expect(imagesOf(out[0])).toHaveLength(info.collapsedImages);
  }, 60_000);

  it('sends every admitted page with its bytes in it', async () => {
    const msgs = plainConvo(624);
    const full = await collapseHistory(msgs, always, COARSE);
    const byteBudget = Math.floor(full.info.collapsedImageBytes / 4);
    clearRenderCache();
    const { messages: out, info } = await collapseHistory(msgs, always, { ...COARSE, byteBudget });

    // Deferring the encoding leaves a block empty until it is admitted. None may
    // leave that way: an empty image is a 400 for the whole request.
    const sent = imagesOf(out[0]);
    expect(sent.length).toBeGreaterThan(0);
    let decoded = 0;
    for (const data of sent) {
      expect(data.length).toBeGreaterThan(0);
      decoded += Buffer.from(data, 'base64').length;
    }
    expect(decoded).toBe(info.collapsedImageBytes);
    // Same for a collapse nothing was cut from.
    for (const data of imagesOf(full.messages[0])) expect(data.length).toBeGreaterThan(0);
  }, 60_000);

  it('holds for the pages of pasted prompts as well', async () => {
    // A prompt past 2000 characters is a pasted document. It is imaged on its own,
    // next to the transcript, by a second piece of code with its own blocks.
    const msgs = plainConvo(624).map((m, i) =>
      i % 20 === 0 ? { ...m, content: `pasted ${i}: ` + prose(1000 + i, 6000) } : m,
    );
    const full = await collapseHistory(msgs, always, COARSE);
    const transcriptOnly = await collapseHistory(plainConvo(624), always, COARSE);
    // The premise: the pasted prompts did become pages.
    expect(full.info.collapsedImages).toBeGreaterThan(transcriptOnly.info.collapsedImages);

    const byteBudget = Math.floor(full.info.collapsedImageBytes / 4);
    clearRenderCache();
    encoded.bytes = 0;
    const { messages: out, info } = await collapseHistory(msgs, always, { ...COARSE, byteBudget });

    expect(info.byteTrimmed).toBe(true);
    expect(renderCacheStats().bytes).toBeGreaterThan(info.collapsedImageBytes * 1.05);
    expect(encoded.bytes).toBe(info.collapsedImageBytes);
    const sent = imagesOf(out[0]);
    expect(sent).toHaveLength(info.collapsedImages);
    for (const data of sent) expect(data.length).toBeGreaterThan(0);
  }, 60_000);

  it('encodes nothing for a history it ends up refusing', async () => {
    const msgs = plainConvo(124);
    const { messages: out, info } = await collapseHistory(msgs, always, {
      imageBudget: 0,
      byteBudget: 1,
    });

    expect(out).toBe(msgs);
    expect(info.reason).toBe('image_bytes');
    // It had to look: the refusal is measured, not assumed.
    expect(renderCacheStats().misses).toBeGreaterThan(0);
    expect(encoded.bytes).toBe(0);
  }, 60_000);
});
