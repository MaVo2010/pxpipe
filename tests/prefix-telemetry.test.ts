import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { clientSessionId } from '../src/core/client-session.js';
import { transformRequest } from '../src/core/transform.js';
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

describe('transformRequest sets clientSessionSha8', () => {
  it('on a short request that never collapses', async () => {
    const body = new TextEncoder().encode(JSON.stringify({
      model: 'claude-opus-5-5',
      metadata: { user_id: userIdJson(SID) },
      system: 'short',
      messages: [{ role: 'user', content: 'hi' }],
    }));
    const { info } = await transformRequest(body, {});
    expect(info.clientSessionSha8).toMatch(/^[0-9a-f]{8}$/);
    const other = await transformRequest(new TextEncoder().encode(JSON.stringify({
      model: 'claude-opus-5-5',
      metadata: { user_id: userIdJson(SID.replace('0f1e', 'aaaa')) },
      system: 'short',
      messages: [{ role: 'user', content: 'hi' }],
    })), {});
    expect(other.info.clientSessionSha8).not.toBe(info.clientSessionSha8);
  });
  it('stays unset without metadata', async () => {
    const body = new TextEncoder().encode(JSON.stringify({
      model: 'claude-opus-5-5', system: 'short', messages: [{ role: 'user', content: 'hi' }],
    }));
    const { info } = await transformRequest(body, {});
    expect(info.clientSessionSha8).toBeUndefined();
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
});

describe('PrefixDivergence', () => {
  const fp = prefixFingerprint;
  it('reports new, then none for a pure append', () => {
    const d = new PrefixDivergence(8);
    expect(d.observe('k', fp(req([u('q1', true)])))).toBe('new');
    expect(d.observe('k', fp(req([u('q1'), a('r1'), u('q2', true)])))).toBe('none');
  });
  it('names the first rewritten message', () => {
    const d = new PrefixDivergence(8);
    d.observe('k', fp(req([u('q1'), a('r1'), u('q2'), a('r2'), u('q3')])));
    expect(d.observe('k', fp(req([u('q1'), a('r1'), u('q2 EDIT'), a('r2'), u('q3'), a('r3'), u('q4')]))))
      .toBe('m2');
  });
  it('names a shortened conversation by the first missing message', () => {
    const d = new PrefixDivergence(8);
    d.observe('k', fp(req([u('q1'), a('r1'), u('q2')])));
    expect(d.observe('k', fp(req([u('q1')])))).toBe('m1');
  });
  it('names tools, system and head before any message', () => {
    const d = new PrefixDivergence(8);
    d.observe('k', fp(req([u('q1')])));
    expect(d.observe('k', fp(req([u('q1'), a('r'), u('q2')], { tools: [] })))).toBe('tools');
    expect(d.observe('k', fp(req([u('q1')], { tools: [], system: 'other' })))).toBe('system');
    expect(d.observe('k', fp(req([u('q1')], { tools: [], system: 'other', thinking: { type: 'enabled', budget_tokens: 9 } }))))
      .toBe('head');
  });
  it('keeps conversations apart by key and forgets the least recently seen past the cap', () => {
    const d = new PrefixDivergence(2);
    d.observe('a', fp(req([u('a1')])));
    d.observe('b', fp(req([u('b1')])));
    expect(d.observe('a', fp(req([u('a1'), a('r'), u('a2')])))).toBe('none'); // a is now the freshest
    d.observe('c', fp(req([u('c1')]))); // evicts b, not a
    expect(d.observe('a', fp(req([u('a1'), a('r'), u('a2'), a('r2'), u('a3')])))).toBe('none');
    expect(d.observe('b', fp(req([u('b1'), a('r'), u('b2')])))).toBe('new');
  });
});

describe('makePrefixTelemetry', () => {
  const bytes = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
  const baseInfo = () => ({
    compressed: false, origChars: 0, compressedChars: 0, imageCount: 0, imageBytes: 0,
    staticChars: 0, dynamicChars: 0, dynamicBlockCount: 0, droppedChars: 0,
  });
  it('keys one conversation by client session + model + session-state key and fills the info fields', () => {
    const t = makePrefixTelemetry();
    const i1 = { ...baseInfo(), clientSessionSha8: 'cafe0001', sessionStateKey: 'aaaa0001' };
    t(bytes(req([u('q1', true)])), i1);
    expect(i1).toMatchObject({ prefixDiverge: 'new', prefixMsgs: 1 });
    expect(typeof (i1 as { prefixMs?: number }).prefixMs).toBe('number');
    expect((i1 as { prefixPrevMsgs?: number }).prefixPrevMsgs).toBeUndefined();
    const i2 = { ...baseInfo(), clientSessionSha8: 'cafe0001', sessionStateKey: 'aaaa0001' };
    t(bytes(req([u('q1'), a('r1'), u('q2', true)])), i2);
    // prefixPrevMsgs makes the row self-contained: diverge === `m${prev - 1}` means only
    // the previous LAST message changed, without joining on the previous event.
    expect(i2).toMatchObject({ prefixDiverge: 'none', prefixMsgs: 3, prefixPrevMsgs: 1 });
    // A sibling conversation in the same client session that opens with the SAME
    // prompt (a second subagent) has its own key and is not compared with the first.
    const i3 = { ...baseInfo(), clientSessionSha8: 'cafe0001', sessionStateKey: 'bbbb0002' };
    t(bytes(req([u('q1'), a('another reply'), u('x', true)])), i3);
    expect(i3.prefixDiverge).toBe('new');
  });
  it('falls back to the first message when no session-state key exists yet', () => {
    const t = makePrefixTelemetry();
    const i1 = { ...baseInfo(), clientSessionSha8: 'cafe0001' };
    t(bytes(req([u('first')])), i1);
    const i2 = { ...baseInfo(), clientSessionSha8: 'cafe0001' };
    t(bytes(req([u('first'), a('r'), u('second')])), i2);
    expect(i2.prefixDiverge).toBe('none');
  });
  it('never throws on a body it cannot read', () => {
    const t = makePrefixTelemetry();
    const i = baseInfo();
    expect(() => t(new TextEncoder().encode('{not json'), i)).not.toThrow();
    expect((i as { prefixDiverge?: string }).prefixDiverge).toBeUndefined();
  });
});

describe('proxy wiring', () => {
  let ambient: string | undefined;
  beforeAll(() => { ambient = process.env.PXPIPE_MODELS; process.env.PXPIPE_MODELS = 'claude-opus-5-5'; });
  afterAll(() => { if (ambient === undefined) delete process.env.PXPIPE_MODELS; else process.env.PXPIPE_MODELS = ambient; });

  it('hands the outgoing body to prefixTelemetry and the fields reach the track event', async () => {
    const real = globalThis.fetch;
    let sentBody = '';
    globalThis.fetch = (async (r: Request | string | URL, init?: RequestInit) => {
      const rq = r instanceof Request ? r : new Request(String(r), init);
      sentBody = await rq.text();
      return new Response(JSON.stringify({
        id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    let seen = '';
    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      prefixTelemetry: (body, info) => {
        seen = new TextDecoder().decode(body);
        Object.assign(info, { prefixDiverge: 'none', prefixMsgs: 5, prefixPrevMsgs: 3, prefixMs: 1.5 });
      },
      onRequest: (e) => { captured = e; },
    });
    const res = await proxy(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5-5', metadata: { user_id: userIdJson(SID) }, system: 'short', messages: [{ role: 'user', content: 'hi' }] }),
    }));
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    globalThis.fetch = real;
    expect(seen).toBe(sentBody);
    const ev = toTrackEvent(captured!);
    expect(ev).toMatchObject({ prefix_diverge: 'none', prefix_msgs: 5, prefix_prev_msgs: 3, prefix_ms: 1.5 });
    expect(ev.client_session_sha8).toMatch(/^[0-9a-f]{8}$/);
  });
});
