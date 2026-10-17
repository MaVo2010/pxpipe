import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { clientSessionId } from '../src/core/client-session.js';
import { transformRequest, prefixConversationKeys, type TransformInfo } from '../src/core/transform.js';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';
import { toTrackEvent } from '../src/core/tracker.js';
import {
  prefixFingerprint,
  PrefixDivergence,
  makePrefixTelemetry,
} from '../src/prefix-telemetry.js';

const SID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const userIdJson = (sid: string) =>
  JSON.stringify({ device_id: 'd'.repeat(40), account_uuid: '11111111-2222-3333-4444-555555555555', session_id: sid });

describe('clientSessionId', () => {
  it('reads session_id from the JSON-encoded metadata.user_id Claude Code sends', () => {
    expect(clientSessionId({ user_id: userIdJson(SID) })).toBe(SID);
  });
  it('reads the legacy flat user_..._session_<uuid> form', () => {
    expect(clientSessionId({ user_id: `user_abc_account_def_session_${SID}` })).toBe(SID);
  });
  it('returns undefined when there is no session to read', () => {
    expect(clientSessionId(undefined)).toBeUndefined();
    expect(clientSessionId({})).toBeUndefined();
    expect(clientSessionId({ user_id: 'plain-user' })).toBeUndefined();
    expect(clientSessionId({ user_id: '{"session_id": 7}' })).toBeUndefined();
  });
});

describe('transformRequest sets the client session and conversation keys', () => {
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
  it('on a short request that never collapses', async () => {
    const body = enc({
      model: 'claude-opus-5-5',
      metadata: { user_id: userIdJson(SID) },
      system: 'short',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const { info } = await transformRequest(body, {});
    expect(info.clientSessionSha8).toMatch(/^[0-9a-f]{8}$/);
    expect(info.prefixKey).toMatch(/^[0-9a-f]{8}$/);
    expect(info.prefixOpenKey).toBe(info.prefixKey); // no reply yet: both keys are the opening
    const other = await transformRequest(enc({
      model: 'claude-opus-5-5',
      metadata: { user_id: userIdJson(SID.replace('0f1e', 'aaaa')) },
      system: 'short',
      messages: [{ role: 'user', content: 'hi' }],
    }), {});
    expect(other.info.clientSessionSha8).not.toBe(info.clientSessionSha8);
  });
  it('stays unset without metadata', async () => {
    const { info } = await transformRequest(enc({
      model: 'claude-opus-5-5', system: 'short', messages: [{ role: 'user', content: 'hi' }],
    }), {});
    expect(info.clientSessionSha8).toBeUndefined();
  });
});

describe('prefixConversationKeys', () => {
  const r = (msgs: unknown[], model = 'claude-opus-5-5') => ({ model, messages: msgs }) as never;
  it('keeps the opening key from turn 1 and adds the reply on turn 2', async () => {
    const t1 = await prefixConversationKeys(r([{ role: 'user', content: 'q1' }]));
    const t2 = await prefixConversationKeys(r([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_A', name: 'Bash', input: {} }] },
      { role: 'user', content: 'q2' },
    ]));
    expect(t1.key).toBe(t1.openKey);
    expect(t2.openKey).toBe(t1.key);
    expect(t2.key).not.toBe(t2.openKey);
  });
  it('separates siblings that open alike by their first reply, and models', async () => {
    const s = (id: string, model?: string) => prefixConversationKeys(r([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] },
    ], model));
    expect((await s('toolu_A')).key).not.toBe((await s('toolu_B')).key);
    expect((await s('toolu_A')).key).not.toBe((await s('toolu_A', 'claude-fable-5-1')).key);
    // Turn 1 too: the same opening prompt to two models is two conversations.
    const t1 = (model: string) => prefixConversationKeys(r([{ role: 'user', content: 'q1' }], model));
    expect((await t1('claude-opus-5-5')).openKey).not.toBe((await t1('claude-fable-5-1')).openKey);
  });
});

type Msg = { role: string; content: unknown };
const req = (messages: Msg[], extra: Record<string, unknown> = {}) => ({
  model: 'claude-opus-5-5',
  tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
  system: [{ type: 'text', text: 'You are helpful.' }],
  messages,
  ...extra,
});
const u = (t: string, cc = false): Msg => ({
  role: 'user',
  content: [{ type: 'text', text: t, ...(cc ? { cache_control: { type: 'ephemeral' } } : {}) }],
});
const a = (t: string): Msg => ({ role: 'assistant', content: [{ type: 'text', text: t }] });

describe('prefixFingerprint', () => {
  it('ignores cache_control, so a marker moving to the new tail is not a change', () => {
    const before = prefixFingerprint(req([u('q1', true)]));
    const after = prefixFingerprint(req([u('q1'), a('r1'), u('q2', true)]));
    expect(after.msgs[0]).toBe(before.msgs[0]);
  });
  it('sees a change inside a large image payload', () => {
    const img = (d: string): Msg => ({
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: d } }],
    });
    const x = 'A'.repeat(100_000);
    expect(prefixFingerprint(req([img(x)])).msgs[0])
      .not.toBe(prefixFingerprint(req([img(x.slice(0, -1) + 'B')])).msgs[0]);
  });
  it('does not let a leading billing header block churn the system hash', () => {
    const bill = (n: string) => ({ type: 'text', text: `x-anthropic-billing-header: cc_version=2.1.0; cch=${n};` });
    const s1 = prefixFingerprint(req([u('q')], { system: [bill('aaaa'), { type: 'text', text: 'S' }] })).system;
    const s2 = prefixFingerprint(req([u('q')], { system: [bill('bbbb'), { type: 'text', text: 'S' }] })).system;
    expect(s1).toBe(s2);
  });
  it('keeps value boundaries distinct (["ab","c"] is not ["a","bc"])', () => {
    const f1 = prefixFingerprint(req([{ role: 'user', content: ['ab', 'c'] }]));
    const f2 = prefixFingerprint(req([{ role: 'user', content: ['a', 'bc'] }]));
    expect(f1.msgs[0]).not.toBe(f2.msgs[0]);
  });
  it('head covers every other top-level field and the beta header, not metadata/stream/max_tokens', () => {
    const h = (extra: Record<string, unknown>, beta?: string) => prefixFingerprint(req([u('q')], extra), beta).head;
    const base = h({});
    expect(h({ temperature: 0.5 })).not.toBe(base);
    expect(h({ output_config: { effort: 'high' } })).not.toBe(base);
    expect(h({}, 'context-1m-2025-08-07')).not.toBe(base);
    expect(h({ metadata: { user_id: 'x' }, stream: true, max_tokens: 99 })).toBe(base);
  });
});

describe('PrefixDivergence', () => {
  const fp = (msgs: Msg[], extra: Record<string, unknown> = {}) => prefixFingerprint(req(msgs, extra));
  const A1 = [u('q1')];
  const A2 = [...A1, a('a1'), u('q2')];
  const A3 = [...A2, a('a2'), u('q3')];
  it('reports new, then none for a pure append', () => {
    const d = new PrefixDivergence();
    expect(d.compare('k', fp(A1))).toEqual({ diverge: 'new' });
    expect(d.compare('k', fp(A2))).toEqual({ diverge: 'none', prevMsgs: 1, reuseMsgs: 1 });
  });
  it('names the first rewritten message against the most recent request', () => {
    const d = new PrefixDivergence();
    d.compare('k', fp(A1));
    d.compare('k', fp(A2));
    d.compare('k', fp(A3));
    // A3 rewritten at message 2 (e.g. an old tool result cleared): the older A1 is still a
    // full prefix, but the cache that was lost is A3's, so A3 is the reference.
    const r = d.compare('k', fp([u('q1'), a('a1'), u('q2 CLEARED'), a('a2'), u('q3'), a('a3'), u('q4')]));
    expect(r).toEqual({ diverge: 'm2', prevMsgs: 5, reuseMsgs: 1 });
  });
  it('names a shortened conversation by the first missing message', () => {
    const d = new PrefixDivergence();
    d.compare('k', fp(A2));
    expect(d.compare('k', fp(A1)).diverge).toBe('m1');
  });
  it('names head, tools and system before any message', () => {
    const d = new PrefixDivergence();
    d.compare('k', fp(A1));
    expect(d.compare('k', fp(A2, { tools: [] })).diverge).toBe('tools');
    expect(d.compare('k', fp(A2, { tools: [], system: 'other' })).diverge).toBe('system');
    expect(d.compare('k', fp(A2, { tools: [], system: 'other', thinking: { type: 'enabled', budget_tokens: 9 } })).diverge)
      .toBe('head');
  });
  it('a fork does not derail its parent', () => {
    const d = new PrefixDivergence();
    d.compare('k', fp(A2));
    d.compare('k', fp(A3));
    const fork1 = [...A3, a('a3'), u('FORK: do the side task')];
    expect(d.compare('k', fp(fork1)).diverge).toBe('none');
    // The parent's next turn shares one more message with the fork than with A3; the
    // reusable prefix is still A3's whole request.
    const parent4 = [...A3, a('a3'), u('q4')];
    expect(d.compare('k', fp(parent4)).reuseMsgs).toBe(5);
    expect(d.compare('k', fp([...fork1, a('f1'), u('f2')])).diverge).toBe('none');
    expect(d.compare('k', fp([...parent4, a('a4'), u('q5')])).diverge).toBe('none');
  });
  it('store:false judges without becoming the reference', () => {
    const d = new PrefixDivergence();
    d.compare('k', fp(A2));
    expect(d.compare('k', fp([u('q1'), a('BROKEN'), u('q2')]), { store: false }).diverge).toBe('m1');
    expect(d.compare('k', fp(A3)).diverge).toBe('none');
    const fresh = new PrefixDivergence();
    expect(fresh.compare('x', fp(A1), { store: false }).diverge).toBe('new');
    expect(fresh.compare('x', fp(A1)).diverge).toBe('new');
  });
  it('moves the turn-1 entry over from the opening key', () => {
    const d = new PrefixDivergence();
    d.compare('open', fp(A1));
    expect(d.compare('full', fp(A2), { fallbackKey: 'open' }).diverge).toBe('none');
    expect(d.compare('open', fp(A1)).diverge).toBe('new'); // moved, not copied
  });
  it('keeps at most perKey requests per key and forgets the least recently seen key past the cap', () => {
    const d = new PrefixDivergence(2, 2);
    d.compare('k', fp(A1));
    d.compare('k', fp(A2));
    d.compare('k', fp(A3));
    // A1 fell out: a request equal to A1 only shares a prefix with A2/A3 now.
    expect(d.compare('k', fp(A1)).reuseMsgs).toBe(0);
    d.compare('a', fp([u('a1')]));
    d.compare('k', fp(A3)); // k is now fresher than a
    d.compare('c', fp([u('c1')])); // evicts a, not k
    expect(d.compare('k', fp(A3)).diverge).toBe('none');
    expect(d.compare('a', fp([u('a1')])).diverge).toBe('new');
  });
});

describe('makePrefixTelemetry', () => {
  const bytes = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
  const baseInfo = (): TransformInfo => ({
    compressed: false, origChars: 0, compressedChars: 0, imageCount: 0, imageBytes: 0,
    staticChars: 0, dynamicChars: 0, dynamicBlockCount: 0, droppedChars: 0,
  });
  it('continues from turn 1 to turn 2 and fills the info fields', async () => {
    const t = makePrefixTelemetry();
    const i1 = { ...baseInfo(), clientSessionSha8: 'cafe0001', prefixKey: 'open0001', prefixOpenKey: 'open0001' };
    await t(bytes(req([u('q1', true)])), i1, { status: 200 });
    expect(i1).toMatchObject({ prefixDiverge: 'new', prefixMsgs: 1 });
    expect(i1.prefixPrevMsgs).toBeUndefined();
    expect(typeof i1.prefixMs).toBe('number');
    const i2 = { ...baseInfo(), clientSessionSha8: 'cafe0001', prefixKey: 'full0001', prefixOpenKey: 'open0001' };
    await t(bytes(req([u('q1'), a('r1'), u('q2', true)])), i2, { status: 200 });
    expect(i2).toMatchObject({ prefixDiverge: 'none', prefixMsgs: 3, prefixPrevMsgs: 1, prefixReuseMsgs: 1 });
  });
  it('keeps client sessions apart', async () => {
    const t = makePrefixTelemetry();
    await t(bytes(req([u('q1')])), { ...baseInfo(), clientSessionSha8: 's1', prefixKey: 'k', prefixOpenKey: 'k' }, { status: 200 });
    const i = { ...baseInfo(), clientSessionSha8: 's2', prefixKey: 'k', prefixOpenKey: 'k' };
    await t(bytes(req([u('q1'), a('r'), u('q2')])), i, { status: 200 });
    expect(i.prefixDiverge).toBe('new');
  });
  it('does not keep a failed request as the reference', async () => {
    const t = makePrefixTelemetry(512, 1); // one slot: a stored failure would evict the good one
    const inf = () => ({ ...baseInfo(), clientSessionSha8: 's', prefixKey: 'k', prefixOpenKey: 'k' });
    await t(bytes(req([u('q1'), a('r1'), u('q2')])), inf(), { status: 200 });
    const bad = inf();
    await t(bytes(req([u('q1'), a('XX'), u('q2')])), bad, { status: 529 });
    expect(bad.prefixDiverge).toBe('m1');
    const next = inf();
    await t(bytes(req([u('q1'), a('r1'), u('q2'), a('r2'), u('q3')])), next, { status: 200 });
    expect(next.prefixDiverge).toBe('none');
  });
  it('derives session and keys from the body when the transform never parsed it', async () => {
    const t = makePrefixTelemetry();
    const body = { ...req([u('q1')]), metadata: { user_id: userIdJson(SID) } };
    const i = baseInfo();
    await t(bytes(body), i, { status: 200 });
    const viaTransform = (await transformRequest(bytes({ model: 'claude-opus-5-5', metadata: { user_id: userIdJson(SID) }, system: 's', messages: [{ role: 'user', content: 'x' }] }), {})).info;
    expect(i.clientSessionSha8).toBe(viaTransform.clientSessionSha8);
    expect(i.prefixDiverge).toBe('new');
    const i2 = baseInfo();
    await t(bytes({ ...body, messages: [u('q1'), a('r'), u('q2')] }), i2, { status: 200 });
    expect(i2.prefixDiverge).toBe('none');
    // Another conversation of the same session is keyed apart, not read as a rewrite.
    const i3 = baseInfo();
    await t(bytes({ ...body, messages: [u('other opening'), a('r'), u('x')] }), i3, { status: 200 });
    expect(i3.prefixDiverge).toBe('new');
  });
  it('never throws on a body it cannot read', async () => {
    const t = makePrefixTelemetry();
    const i = baseInfo();
    await expect(t(new TextEncoder().encode('{not json'), i, { status: 200 })).resolves.toBeUndefined();
    expect(i.prefixDiverge).toBeUndefined();
  });
});

describe('proxy wiring', () => {
  let ambient: string | undefined;
  beforeAll(() => { ambient = process.env.PXPIPE_MODELS; process.env.PXPIPE_MODELS = 'claude-opus-5-5,gemini-3.6-flash'; });
  afterAll(() => { if (ambient === undefined) delete process.env.PXPIPE_MODELS; else process.env.PXPIPE_MODELS = ambient; });

  const okMessages = () => new Response(JSON.stringify({
    id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  async function run(
    hook: NonNullable<Parameters<typeof createProxy>[0]['prefixTelemetry']>,
    url = 'http://localhost/v1/messages',
    body: unknown = { model: 'claude-opus-5-5', metadata: { user_id: userIdJson(SID) }, system: 'short', messages: [{ role: 'user', content: 'hi' }] },
    respond: () => Response = okMessages,
    transform: Record<string, unknown> = {},
  ) {
    const real = globalThis.fetch;
    let sentBody = '';
    globalThis.fetch = (async (r: Request | string | URL, init?: RequestInit) => {
      const rq = r instanceof Request ? r : new Request(String(r), init);
      if (!rq.url.includes('countTokens') && !rq.url.includes('count_tokens')) sentBody = await rq.text();
      return respond();
    }) as typeof fetch;
    let captured: ProxyEvent | undefined;
    try {
      const proxy = createProxy({ upstream: 'http://gateway.test', transform, prefixTelemetry: hook, onRequest: (e) => { captured = e; } });
      const res = await proxy(new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'anthropic-beta': 'beta-x' },
        body: JSON.stringify(body),
      }));
      await res.text();
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      globalThis.fetch = real;
    }
    return { captured, sentBody };
  }

  it('hands the outgoing body, status and beta header to the hook; the fields reach the track event', async () => {
    let seen = '';
    let ctx: unknown;
    const { captured, sentBody } = await run((body, info, c) => {
      seen = new TextDecoder().decode(body);
      ctx = c;
      Object.assign(info, { prefixDiverge: 'none', prefixMsgs: 5, prefixPrevMsgs: 3, prefixReuseMsgs: 3, prefixMs: 1.5 });
    });
    expect(seen).toBe(sentBody);
    expect(ctx).toEqual({ status: 200, beta: 'beta-x' });
    const ev = toTrackEvent(captured!);
    expect(ev).toMatchObject({ prefix_diverge: 'none', prefix_msgs: 5, prefix_prev_msgs: 3, prefix_reuse_msgs: 3, prefix_ms: 1.5 });
    expect(ev.client_session_sha8).toMatch(/^[0-9a-f]{8}$/);
  });
  it('still writes the event row when the hook throws', async () => {
    const { captured } = await run(() => { throw new Error('boom'); });
    expect(captured?.status).toBe(200);
  });
  it('passes the upstream status on failures', async () => {
    let status: number | undefined;
    await run((_b, _i, c) => { status = c.status; }, undefined, undefined,
      () => new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'x' } }), { status: 529, headers: { 'content-type': 'application/json' } }));
    expect(status).toBe(529);
  });
  it('carries the client session on compress=false through the real hook', async () => {
    const { captured } = await run(makePrefixTelemetry(), undefined, undefined, okMessages, { compress: false });
    const ev = toTrackEvent(captured!);
    expect(ev.client_session_sha8).toMatch(/^[0-9a-f]{8}$/);
    expect(ev.prefix_diverge).toBe('new');
  });
  it('does not run on the Google route', async () => {
    let called = false;
    await run(() => { called = true; },
      'http://localhost/google-ai-studio/v1beta/models/gemini-3.6-flash:generateContent',
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      () => new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 },
      }), { headers: { 'content-type': 'application/json' } }));
    expect(called).toBe(false);
  });
});
