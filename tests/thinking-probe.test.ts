import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';
import { toTrackEvent } from '../src/core/tracker.js';
import { anthropicVisionTokens } from '../src/core/anthropic-vision.js';

let ambient: string | undefined;
beforeAll(() => {
  ambient = process.env.PXPIPE_MODELS;
  process.env.PXPIPE_MODELS = 'claude-fable-5';
});
afterAll(() => {
  if (ambient === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = ambient;
});

function mockUpstream(handler: (req: Request) => Promise<Response> | Response) {
  const real = globalThis.fetch;
  globalThis.fetch = ((req: Request | string | URL, init?: RequestInit) => {
    const r = req instanceof Request ? req : new Request(String(req), init);
    return Promise.resolve(handler(r));
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

const slab = (n: number) =>
  '# CLAUDE.md\nYou are a helpful coding assistant.\n' + 'Follow the rules carefully. '.repeat(Math.ceil(n / 28));
// 1×1 PNG the CLIENT sends; it must survive into the probe.
const CLIENT_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const body = (stream = false) => JSON.stringify({
  model: 'claude-fable-5',
  max_tokens: 16,
  stream,
  system: [{ type: 'text', text: slab(80_000), cache_control: { type: 'ephemeral' } }],
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'hello' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: CLIENT_PNG } },
    ],
  }],
});
const ok = (n: number) =>
  new Response(JSON.stringify({ input_tokens: n }), { status: 200, headers: { 'content-type': 'application/json' } });
const isOriginal = (b: string) => b.includes('Follow the rules carefully');
const USAGE = { input_tokens: 40, output_tokens: 2, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0 };
const jsonReply = () => new Response(JSON.stringify({
  id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }],
  model: 'claude-fable-5', stop_reason: 'end_turn', usage: USAGE,
}), { status: 200, headers: { 'content-type': 'application/json' } });
const sseReply = () => {
  const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  return new Response(
    ev('message_start', { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-fable-5', content: [], stop_reason: null, usage: { ...USAGE, output_tokens: 1 } } }) +
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    // Cumulative usage, as the live wire sends it: the SSE scanner replaces its
    // usage with any top-level `usage`, so an output-only delta would drop the cache fields.
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: USAGE }) +
    ev('message_stop', { type: 'message_stop' }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
};

async function drive(
  reqBody: string,
  countTokens: (probeBody: string) => Promise<Response> | Response,
  reply: () => Response = jsonReply,
  settleMs = 60,
  /** Optional: every upstream call in the order it was ISSUED (slot taken
   *  before the body is read, label filled in once it is). */
  order?: string[],
) {
  const probes: string[] = [];
  const forwarded: string[] = [];
  const restore = mockUpstream(async (req) => {
    const url = new URL(req.url);
    if (url.pathname === '/v1/messages/count_tokens') {
      const slot = order ? order.push('probe') - 1 : -1;
      const b = await req.text();
      if (order) order[slot] = isOriginal(b) ? 'probe-original' : 'probe-sent';
      probes.push(b);
      return countTokens(b);
    }
    order?.push('forward');
    forwarded.push(await req.text());
    return reply();
  });
  let event: ProxyEvent | undefined;
  const proxy = createProxy({ upstream: 'http://mock', transform: {}, onRequest: (e) => { event = e; } });
  const res = await proxy(new Request('http://proxy/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: reqBody,
  }));
  const text = await res.text();
  await new Promise((r) => setTimeout(r, settleMs));
  restore();
  return { probes, forwarded, event: event!, status: res.status, text };
}

describe('third count_tokens probe (sent body without pxpipe images)', () => {
  it('compressed request: counts the sent body, keeps the client image, prices pxpipe images', async () => {
    const d = await drive(body(), (b) => ok(isOriginal(b) ? 9000 : 3000));
    const info = d.event.info!;
    expect(info.compressed).toBe(true);
    expect(d.probes).toHaveLength(3);
    const third = d.probes.find((b) => !isOriginal(b))!;
    const forwarded = d.forwarded[0]!;
    expect(forwarded.match(/"type":"image"/g)!.length).toBeGreaterThan(1);
    expect(third.match(/"type":"image"/g)).toHaveLength(1);
    expect(third).toContain(CLIENT_PNG);
    expect(third.length).toBeLessThan(forwarded.length / 4);
    expect(info.sentProbeStatus).toBe('ok');
    expect(info.sentCountTokens).toBe(3000);
    const want = info.imageDims!.reduce(
      (a, x) => a + anthropicVisionTokens('claude-fable-5', x.width, x.height), 0);
    expect(info.sentImageTokensEst).toBe(want);
    expect(info.sentImageTokensEst).toBeGreaterThan(0);
  });

  it('the main forward is issued before the third probe (default duplicate hold)', async () => {
    const order: string[] = [];
    const d = await drive(body(), (b) => ok(isOriginal(b) ? 9000 : 3000), jsonReply, 60, order);
    expect(d.event.info?.compressed).toBe(true);
    expect(order.indexOf('forward')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('forward')).toBeLessThan(order.indexOf('probe-sent'));
    expect(order.filter((x) => x === 'probe-sent')).toHaveLength(1);
  });

  it('uncompressed request: no third probe, status skipped', async () => {
    const plain = JSON.stringify({
      model: 'claude-fable-5', max_tokens: 16, system: 'short', messages: [{ role: 'user', content: 'hi' }],
    });
    const d = await drive(plain, () => ok(10));
    expect(d.event.info?.compressed).toBe(false);
    expect(d.probes).toHaveLength(1);
    expect(d.event.info?.sentProbeStatus).toBe('skipped');
    expect(d.event.info?.sentCountTokens).toBeUndefined();
  });

  it('third probe fails: status failed, baseline probes and client response unaffected', async () => {
    const d = await drive(body(), (b) => (isOriginal(b) ? ok(9000) : new Response('busy', { status: 429 })));
    expect(d.status).toBe(200);
    expect(JSON.parse(d.text).content[0].text).toBe('ok');
    expect(d.event.info?.baselineProbeStatus).toBe('ok');
    expect(d.event.info?.sentProbeStatus).toBe('failed');
    expect(d.event.info?.sentCountTokens).toBeUndefined();
  });

  it('streamed response with a slow third probe: the row still carries the measurement', async () => {
    const d = await drive(
      body(true),
      async (b) => {
        if (isOriginal(b)) return ok(9000);
        await new Promise((r) => setTimeout(r, 120)); // resolves after the stream ended
        return ok(3000);
      },
      sseReply,
      300,
    );
    expect(d.text).toContain('message_stop');
    expect(d.event.usage?.cache_creation_input_tokens).toBe(3000);
    expect(d.event.info?.sentProbeStatus).toBe('ok');
    expect(d.event.info?.sentCountTokens).toBe(3000);
  });

  it('toTrackEvent writes the three sent_* fields', () => {
    const t = toTrackEvent({
      method: 'POST', path: '/v1/messages', status: 200, durationMs: 1,
      info: { compressed: true, sentCountTokens: 3000, sentImageTokensEst: 1456, sentProbeStatus: 'ok' },
    } as never);
    expect(t.sent_count_tokens).toBe(3000);
    expect(t.sent_image_tokens_est).toBe(1456);
    expect(t.sent_probe_status).toBe('ok');
  });
});
