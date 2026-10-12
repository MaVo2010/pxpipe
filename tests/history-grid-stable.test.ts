/**
 * Keeping a warm history cache readable when the collapse range grows.
 *
 * Measured on production traffic 2026-10-08..12 (pxpipe-rollback/analysis-2026-10-12-extend):
 * an extension of the collapsed range on a fine, unchanged grid missed the cache in 10 % of
 * cases; an extension whose freeze step had grown, or whose whole range was one chunk, missed
 * in 95-99 %. Those misses rewrote every history image AND the text tail behind it (one
 * 860k-token session wrote 852k tokens to fold in nine messages). This file pins cause A:
 *
 *  A. The session-state record (sticky freeze step, cache liveness) was keyed by the user's
 *     opening prompt alone. Conversations that open with the same words - also across models -
 *     shared one record, so one large conversation's coarse step (1280) became the floor of
 *     every other one, and those rendered their whole range as a single chunk.
 *
 * A second change was tried and dropped: never coarsening a warm grid, trimming the range at
 * the image budget instead. On a side-port trial (2026-10-12, a 321-request warm Opus session)
 * it cost 6.4 % more than the old doubling: one avoided rewrite against a text tail that grew
 * behind the fixed cut and was read on every request. The single-chunk grid is the real harm;
 * that is a separate change.
 *
 * Run just this file:  pnpm vitest run tests/history-grid-stable.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProxy } from '../src/core/proxy.js';
import { transformRequest } from '../src/core/transform.js';
import { markCacheDead, recordFreezeStep, resetSessionState } from '../src/core/session-state.js';
import { toTrackEvent } from '../src/core/tracker.js';
import type { Message } from '../src/core/types.js';

const big = (n: number) => 'x'.repeat(n);
const enc = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));
const dec = (b: Uint8Array): any => JSON.parse(new TextDecoder().decode(b));

/** Two conversations can open with the same prompt; they differ from the first reply on. */
function convo(firstReply: unknown, n: number, chars = 3500): Message[] {
  const out: Message[] = [
    { role: 'user', content: 'SAME OPENING PROMPT: ' + big(200) },
    { role: 'assistant', content: firstReply as Message['content'] },
  ];
  for (let i = 1; i < n; i++) {
    out.push({ role: i % 2 === 0 ? 'assistant' : 'user', content: `turn ${i}: ` + big(chars) });
  }
  return out;
}
const request = (messages: Message[], model = 'claude-3-5-sonnet') => enc({ model, messages });

describe('A: session state is keyed per conversation, not per opening prompt', () => {
  beforeEach(() => resetSessionState());

  it('two conversations with the same opening prompt get different keys; the log id stays shared', async () => {
    const a = await transformRequest(request(convo('reply A', 120)));
    const b = await transformRequest(request(convo('reply B', 120)));
    expect(a.info.sessionStateKey).toBeTruthy();
    expect(b.info.sessionStateKey).toBeTruthy();
    expect(b.info.sessionStateKey).not.toBe(a.info.sessionStateKey);
    // first_user_sha8 is a log and dashboard field; it keeps its meaning.
    expect(b.info.firstUserSha8).toBe(a.info.firstUserSha8);
  });

  it("one conversation's coarse step does not become another's floor", async () => {
    const a = await transformRequest(request(convo('reply A', 120)));
    recordFreezeStep(a.info.sessionStateKey, 1280);

    const other = await transformRequest(request(convo('reply B', 120)));
    expect(other.info.collapsedTurns).toBeGreaterThan(0);
    expect(other.info.historyFreezeStep).toBeLessThan(other.info.collapsedTurns!);

    // Control: the floor still binds the conversation it was recorded for.
    const again = await transformRequest(request(convo('reply A', 120)));
    expect(again.info.historyFreezeStep).toBeGreaterThanOrEqual(again.info.collapsedTurns!);
  });

  it('is stable while the conversation grows', async () => {
    const short = await transformRequest(request(convo('reply A', 120)));
    const long = await transformRequest(request(convo('reply A', 220)));
    expect(short.info.sessionStateKey).toBeTruthy();
    expect(long.info.sessionStateKey).toBe(short.info.sessionStateKey);
  });

  it('ignores thinking blocks in the first reply (a client may drop them later)', async () => {
    const withThinking = await transformRequest(request(convo([
      { type: 'thinking', thinking: 'let me see', signature: 'sig-1' },
      { type: 'text', text: 'reply A' },
      { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/x' } },
    ], 120)));
    const without = await transformRequest(request(convo([
      { type: 'text', text: 'reply A' },
      { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/x' } },
    ], 120)));
    expect(withThinking.info.sessionStateKey).toBeTruthy();
    expect(without.info.sessionStateKey).toBe(withThinking.info.sessionStateKey);
  });

  it('tells two replies apart by their tool_use ids when the text is the same', async () => {
    const one = await transformRequest(request(convo([{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: {} }], 120)));
    const two = await transformRequest(request(convo([{ type: 'tool_use', id: 'toolu_02', name: 'Read', input: {} }], 120)));
    expect(two.info.sessionStateKey).not.toBe(one.info.sessionStateKey);
  });

  it('differs by model (each model has its own provider cache)', async () => {
    const sonnet = await transformRequest(request(convo('reply A', 120), 'claude-3-5-sonnet'));
    const haiku = await transformRequest(request(convo('reply A', 120), 'claude-3-5-haiku'));
    expect(haiku.info.sessionStateKey).not.toBe(sonnet.info.sessionStateKey);
  });

  it('is undefined before the first reply exists', async () => {
    const r = await transformRequest(request([{ role: 'user', content: 'SAME OPENING PROMPT: ' + big(200) }]));
    expect(r.info.sessionStateKey).toBeUndefined();
  });

  it('ignores cache_control on the first reply (Claude Code moves its markers every turn)', async () => {
    const plain = await transformRequest(request(convo([{ type: 'text', text: 'reply A' }], 120)));
    const marked = await transformRequest(request(convo([
      { type: 'text', text: 'reply A', cache_control: { type: 'ephemeral' } },
    ], 120)));
    expect(plain.info.sessionStateKey).toBeTruthy();
    expect(marked.info.sessionStateKey).toBe(plain.info.sessionStateKey);
  });

  it('ignores tool_use input (the call id already names the call)', async () => {
    const one = await transformRequest(request(convo([{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/x' } }], 120)));
    const two = await transformRequest(request(convo([{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/y' } }], 120)));
    expect(one.info.sessionStateKey).toBeTruthy();
    expect(two.info.sessionStateKey).toBe(one.info.sessionStateKey);
  });

  it('skips a first reply without visible text (thinking only) and keys on the next one', async () => {
    const r = await transformRequest(request(convo([{ type: 'thinking', thinking: 'let me see', signature: 'sig-1' }], 120)));
    expect(r.info.sessionStateKey).toBeTruthy();
  });

  it('the event log carries the key as session_state_sha8', async () => {
    const r = await transformRequest(request(convo('reply A', 120)));
    const ev = toTrackEvent({ method: 'POST', path: '/v1/messages', model: 'claude-3-5-sonnet', status: 200, durationMs: 1, info: r.info });
    expect(r.info.sessionStateKey).toBeTruthy();
    expect(ev.session_state_sha8).toBe(r.info.sessionStateKey);
  });

  it('a dead-cache mark under the new key reaches the repack', async () => {
    const first = await transformRequest(request(convo('reply A', 120)));
    markCacheDead(first.info.sessionStateKey);
    const second = await transformRequest(request(convo('reply A', 120)));
    expect(second.info.historyPackFill).toBe(true);
    // ...and not a different conversation with the same opening prompt.
    markCacheDead(first.info.sessionStateKey);
    const other = await transformRequest(request(convo('reply B', 120)));
    expect(other.info.historyPackFill).toBeUndefined();
  });
});

describe('A: the proxy feeds the provider answer back under the conversation key', () => {
  let ambient: string | undefined;
  let realFetch: typeof fetch;
  beforeEach(() => {
    resetSessionState();
    ambient = process.env.PXPIPE_MODELS;
    process.env.PXPIPE_MODELS = 'claude-fable-5';
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (ambient === undefined) delete process.env.PXPIPE_MODELS;
    else process.env.PXPIPE_MODELS = ambient;
  });

  /** Upstream answers every /v1/messages with `answer()`; count_tokens probes get a stub. */
  function upstream(answer: () => Response): void {
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      if (new URL(req.url).pathname.endsWith('/count_tokens')) {
        return new Response(JSON.stringify({ input_tokens: 9999 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return answer();
    }) as typeof fetch;
  }
  const ok = (read: number, create: number) => () => new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'claude-fable-5',
    stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: read, cache_creation_input_tokens: create },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const tooLarge = () => new Response(JSON.stringify({ type: 'error', error: { type: 'request_too_large', message: 'too large' } }), {
    status: 413, headers: { 'content-type': 'application/json' },
  });

  async function send(body: Uint8Array): Promise<void> {
    // The cache bookkeeping runs after the response, right before the proxy emits its
    // request event, so the event is the signal that it has landed (no timer to race).
    let landed!: () => void;
    const event = new Promise<void>((r) => { landed = r; });
    const proxy = createProxy({ upstream: 'http://anthropic.test', apiKey: 'sk-ant-test', onRequest: () => landed() });
    const res = await proxy(new Request('http://localhost/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-test' }, body,
    }));
    await res.text();
    await event;
  }

  it('a rejected request marks this conversation dead, so its next turn may repack', async () => {
    const body = request(convo('reply A', 120), 'claude-fable-5');
    upstream(tooLarge);
    await send(body);
    const next = await transformRequest(body);
    expect(next.info.historyPackFill).toBe(true);
  });

  it('a cache that existed and is gone (read and create both 0) lets the next turn repack', async () => {
    const body = request(convo('reply A', 120), 'claude-fable-5');
    upstream(ok(50_000, 1_000));
    await send(body);
    upstream(ok(0, 0));
    await send(body);
    const next = await transformRequest(body);
    expect(next.info.historyPackFill).toBe(true);
  });
});
