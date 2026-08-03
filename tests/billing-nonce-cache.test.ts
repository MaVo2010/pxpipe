/**
 * The prompt-cache prefix must not depend on the per-request billing nonce.
 *
 * Claude Code's interactive CLI entrypoint sends
 *   `x-anthropic-billing-header: cc_version=...; cc_entrypoint=cli; cch=<rnd>; cc_prev_req=req_<id>;`
 * as its own uncached system block. `cch` and `cc_prev_req` change on EVERY
 * request. If that text re-enters the cached prefix, every request has a unique
 * prefix and the prompt cache reads zero — which is what production measured
 * (cache_read_tokens = 0 across 27 consecutive requests).
 *
 * Fixture is a real captured Claude Code request body, so the shape (system
 * block order, cache_control placement) is the client's, not our guess.
 *
 * Run just this file:  pnpm vitest run tests/billing-nonce-cache.test.ts
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cachePrefixDigest, transformRequest } from '../src/core/transform.js';

const FIXTURE = new URL('./fixtures/claude-code-cli-request.json', import.meta.url);

function billingLine(cch: string, prevReq: string): string {
  return `x-anthropic-billing-header: cc_version=2.1.220.85f; cc_entrypoint=cli; cch=${cch}; cc_prev_req=req_${prevReq};`;
}

/** The captured body with a different billing nonce spliced in — nothing else. */
function bodyWithNonce(cch: string, prevReq: string): Uint8Array {
  const req = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const sys = req.system;
  if (!Array.isArray(sys)) throw new Error('fixture system is not a block array');
  const idx = sys.findIndex(
    (b: { type?: string; text?: string }) =>
      typeof b?.text === 'string' && b.text.startsWith('x-anthropic-billing-header:'),
  );
  if (idx < 0) throw new Error('fixture carries no billing header block');
  sys[idx] = { ...sys[idx], text: billingLine(cch, prevReq) };
  return new TextEncoder().encode(JSON.stringify(req));
}

describe('prompt-cache prefix vs. per-request billing nonce', () => {
  it('fixture is a real CLI request: billing header leads, uncached, others cached', () => {
    const req = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    expect(req.system[0].text.startsWith('x-anthropic-billing-header:')).toBe(true);
    expect(req.system[0].cache_control ?? null).toBe(null);
    expect(req.system.slice(1).some((b: { cache_control?: unknown }) => b.cache_control)).toBe(true);
  });

  it('emits the billing header as the leading, uncached system block', async () => {
    const { body } = await transformRequest(bodyWithNonce('aaaaa', 'AAAAAAAAAAAAAAAA'));
    const out = JSON.parse(new TextDecoder().decode(body));

    expect(out.system[0].text.startsWith('x-anthropic-billing-header:')).toBe(true);
    expect(out.system[0].cache_control ?? null).toBe(null);
    // It must appear exactly once: lifted, not copied.
    const carriers = out.system.filter((b: { text?: string }) =>
      (b.text ?? '').includes('x-anthropic-billing-header:'),
    );
    expect(carriers).toHaveLength(1);
    // #149: identity must still lead everything the endpoint classifies on.
    expect(out.system[1].text).toContain('Claude');
  });

  it('confines the nonce to that one block — the whole rest is byte-identical', async () => {
    const a = await transformRequest(bodyWithNonce('aaaaa', 'AAAAAAAAAAAAAAAA'));
    const b = await transformRequest(bodyWithNonce('bbbbb', 'BBBBBBBBBBBBBBBB'));
    const outA = JSON.parse(new TextDecoder().decode(a.body));
    const outB = JSON.parse(new TextDecoder().decode(b.body));

    // Guard against a vacuous pass: the bodies must be substantial and the
    // spliced nonces must actually have survived into the output.
    expect(outA.system.length).toBeGreaterThan(1);
    expect(outA.system[0].text).toContain('cch=aaaaa');
    expect(outB.system[0].text).toContain('cch=bbbbb');

    // Everything after the isolated block — including the imaged slab and the
    // message stream — must not depend on the nonce.
    expect(JSON.stringify(outB.system.slice(1))).toBe(JSON.stringify(outA.system.slice(1)));
    expect(JSON.stringify(outB.messages)).toBe(JSON.stringify(outA.messages));
  });
});

/**
 * The bust *detector* must agree with the endpoint about what the cache key is.
 * It did not: `cache_prefix_sha8` hashed the leading billing block, so it roamed
 * every turn (one repeat in 20) while production measured 74k–92k cache_read
 * against that same "changing" prefix. A detector that cries bust every turn
 * carries no signal.
 */
describe('cache-prefix digest vs. the block the endpoint ignores', () => {
  it('is one stable sha8 across billing nonces — via transformRequest', async () => {
    const a = await transformRequest(bodyWithNonce('aaaaa', 'AAAAAAAAAAAAAAAA'));
    const b = await transformRequest(bodyWithNonce('bbbbb', 'BBBBBBBBBBBBBBBB'));

    // Non-vacuous: a digest must actually have been computed, over a real prefix.
    expect(a.info.cachePrefixSha8).toMatch(/^[0-9a-f]{8}$/);
    expect(a.info.cachePrefixBytes).toBeGreaterThan(1000);
    // And the nonce must really have differed on the way in.
    const outA = JSON.parse(new TextDecoder().decode(a.body));
    const outB = JSON.parse(new TextDecoder().decode(b.body));
    expect(outA.system[0].text).not.toBe(outB.system[0].text);

    expect(b.info.cachePrefixSha8).toBe(a.info.cachePrefixSha8);
    expect(b.info.cachePrefixBytes).toBe(a.info.cachePrefixBytes);
  });

  // Positional, and it matters: only a *leading* billing block is lifted out of
  // the endpoint's cache key. Buried, it does bust the cache — the digest has to
  // keep saying so. Unreachable through transformRequest (liftBillingBlock always
  // re-leads it), hence the direct call.
  const cached = { type: 'text', text: 'static system prefix', cache_control: { type: 'ephemeral' } };
  const reqWith = (system: unknown[]) => ({
    tools: [],
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: '[End of rendered context.]' }] }],
  });
  const bill = (cch: string) => ({ type: 'text', text: billingLine(cch, 'AAAAAAAAAAAAAAAA') });

  it('ignores the nonce when the billing block leads', async () => {
    const a = await cachePrefixDigest(reqWith([bill('aaaaa'), cached]));
    const b = await cachePrefixDigest(reqWith([bill('bbbbb'), cached]));
    expect(a?.sha8).toBeDefined();
    expect(b?.sha8).toBe(a?.sha8);
  });

  it('still reports a bust when the billing block is buried', async () => {
    const a = await cachePrefixDigest(reqWith([cached, bill('aaaaa')]));
    const b = await cachePrefixDigest(reqWith([cached, bill('bbbbb')]));
    expect(a?.sha8).toBeDefined();
    expect(b?.sha8).not.toBe(a?.sha8);
  });
});
