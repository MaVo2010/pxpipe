import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveGptProfile } from '../src/core/gpt-model-profiles.js';
import { transformAnthropicMessages } from '../src/core/library.js';

/**
 * `historyMinTokens`: a per-model floor below which Anthropic message history
 * stays text (the static slab is still imaged).
 *
 * Measured 2026-10-08..11 on claude-opus-5-5 traffic, cost-weighted: collapsing
 * history in requests under ~100k tokens lost 3..120 % against the text path,
 * from 100k up it saved 24..50 %. Small sessions move their collapse boundary
 * often relative to their length, and every move rewrites the cached history at
 * the cache-write rate while text would have been a cache read.
 *
 * Undefined in every shipped profile, so the default path is unchanged.
 */

const ENV = 'PXPIPE_GPT_PROFILES';
const MODELS = 'PXPIPE_MODELS';

beforeEach(() => { process.env[MODELS] = 'claude-opus-5,claude-fable-5'; });
afterEach(() => { delete process.env[ENV]; delete process.env[MODELS]; });

/** Same fixture as history-geometry.test.ts: big enough that history collapses
 *  by default (~224k text chars, ~96k estimated tokens). */
function bodyWithHistory(model: string): Uint8Array {
  const bulk = 'window 0 train 2024-01-15 test breakout+htf @240m d10 seed 780 bars, eligibility ok. ';
  const messages = [];
  for (let i = 0; i < 60; i++) {
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: bulk.repeat(40) + ` turn ${i}` }] });
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: 'continue' }] });
  return new TextEncoder().encode(JSON.stringify({
    model,
    max_tokens: 1024,
    system: [{ type: 'text', text: 'You are a coding agent. '.repeat(500), cache_control: { type: 'ephemeral' } }],
    messages,
  }));
}

describe('historyMinTokens', () => {
  it('is undefined in every shipped profile', () => {
    for (const m of ['claude-opus-5', 'claude-opus-5-5', 'claude-fable-5', 'claude-fable-5-1', 'claude-sonnet-4-5', 'gpt-5.6-sol']) {
      expect(resolveGptProfile(m).historyMinTokens, m).toBeUndefined();
    }
  });

  it('is read from PXPIPE_GPT_PROFILES for the named model only', () => {
    process.env[ENV] = JSON.stringify({ 'claude-opus-5': { historyMinTokens: 100000 } });
    expect(resolveGptProfile('claude-opus-5-5').historyMinTokens).toBe(100000);
    expect(resolveGptProfile('claude-fable-5').historyMinTokens).toBeUndefined();
  });

  it('ignores a non-positive or non-numeric value', () => {
    process.env[ENV] = JSON.stringify({ 'claude-opus-5': { historyMinTokens: 0 } });
    expect(resolveGptProfile('claude-opus-5').historyMinTokens).toBeUndefined();
    process.env[ENV] = JSON.stringify({ 'claude-opus-5': { historyMinTokens: 'lots' } });
    expect(resolveGptProfile('claude-opus-5').historyMinTokens).toBeUndefined();
  });

  it('keeps the history as text below the floor, still images the slab', async () => {
    process.env[ENV] = JSON.stringify({ 'claude-opus-5': { historyMinTokens: 1_000_000 } });
    const r = await transformAnthropicMessages({ body: bodyWithHistory('claude-opus-5-5'), model: 'claude-opus-5-5' });
    expect(r.applied, r.reason).toBe(true);
    expect(r.info.collapsedImages ?? 0).toBe(0);
    expect(r.info.historyReason).toBe('below_min_tokens');
    // Every turn still goes out as text...
    const sent = new TextDecoder().decode(r.body);
    for (const i of [0, 1, 30, 58, 59]) expect(sent).toContain(` turn ${i}"`);
    // ...while the slab is still imaged (pxpipe puts its pages into the first user message).
    expect(r.info.compressed).toBe(true);
    expect(r.info.imageCount).toBeGreaterThan(0);
    expect(sent).toContain('"type":"image"');
  });

  it('applies the floor on the small-slab path too (slab below min chars, history alone)', async () => {
    const tinySlab = (model: string): Uint8Array => {
      const b = JSON.parse(new TextDecoder().decode(bodyWithHistory(model))) as { system: unknown };
      b.system = 'short';
      return new TextEncoder().encode(JSON.stringify(b));
    };
    const plain = await transformAnthropicMessages({ body: tinySlab('claude-opus-5-5'), model: 'claude-opus-5-5' });
    expect(plain.info.historyReason, 'the fixture must collapse on this path by default').toBe('collapsed');
    process.env[ENV] = JSON.stringify({ 'claude-opus-5': { historyMinTokens: 1_000_000 } });
    const floored = await transformAnthropicMessages({ body: tinySlab('claude-opus-5-5'), model: 'claude-opus-5-5' });
    expect(floored.info.historyReason).toBe('below_min_tokens');
    expect(floored.info.collapsedImages ?? 0).toBe(0);
  });

  it('collapses as before above the floor', async () => {
    process.env[ENV] = JSON.stringify({ 'claude-opus-5': { historyMinTokens: 1000 } });
    const r = await transformAnthropicMessages({ body: bodyWithHistory('claude-opus-5-5'), model: 'claude-opus-5-5' });
    expect(r.info.historyReason).toBe('collapsed');
    expect(r.info.collapsedImages ?? 0).toBeGreaterThan(0);
  });

  it('without the field the collapse is unchanged', async () => {
    const plain = await transformAnthropicMessages({ body: bodyWithHistory('claude-opus-5-5'), model: 'claude-opus-5-5' });
    process.env[ENV] = JSON.stringify({ 'claude-opus-5': { historyMinTokens: 1000 } });
    const low = await transformAnthropicMessages({ body: bodyWithHistory('claude-opus-5-5'), model: 'claude-opus-5-5' });
    expect(plain.info.historyReason).toBe('collapsed');
    expect(plain.info.collapsedTurns).toBe(low.info.collapsedTurns);
    expect(new TextDecoder().decode(plain.body)).toBe(new TextDecoder().decode(low.body));
  });
});
