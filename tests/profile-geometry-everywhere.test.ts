/**
 * One readable geometry per model, applied to EVERY imaged body text.
 *
 * Before this change the profile's `historyStripCols` / `historyStyle` covered
 * only the collapsed transcript. Two other image paths stayed hard-wired to
 * the dense 312-col `spleen-5x8` geometry regardless of model:
 *
 *   1. tool_result pages (`compressToolResultsInPlace`, `PXPIPE_COMPRESS_TOOL_RESULTS=1`)
 *   2. over-cap user turns inside the collapse ("too long to carry as text")
 *
 * Measured 2026-10-19 on a blinded 26-value battery at that dense geometry:
 * Fable 5.1 read 2/26 exactly with 15 silent substitutions, Opus 5.5 abstained
 * on all 26. The same battery at the model's readable geometry: Opus 5.5 at
 * `jetbrains-mono-12`/195 100/100; Fable 5.1 at `jetbrains-mono-14`/172 22/26
 * and 74/100 with zero silent errors. A tool result is where the exact values
 * live (hashes, line numbers, amounts), so it must not be the least legible page.
 *
 * Pinned here:
 *   - with a history profile, tool_result pages and over-cap user turns render
 *     at the profile geometry (page width = cols × cell + border);
 *   - without one, both stay at the dense geometry (byte-stable default; the
 *     side-port trial proves byte-identity against the live bundle).
 *
 * The static slab is deliberately NOT moved: it is the cache anchor and carries
 * no exact values.
 *
 * Run just this file:  pnpm vitest run tests/profile-geometry-everywhere.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transformRequest } from '../src/core/transform.js';
import { resetSessionState } from '../src/core/session-state.js';
import type { Message } from '../src/core/types.js';

const ENV = 'PXPIPE_GPT_PROFILES';
const MODELS = 'PXPIPE_MODELS';
const enc = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));
const dec = (b: Uint8Array): any => JSON.parse(new TextDecoder().decode(b));

/** Page widths at full column count (longest line ≥ cols so shrink-to-content
 *  does not narrow the page): cols × cell width + 8 px border, as measured by
 *  the canary generator's differential probe (jb-14: 9 px cell; spleen-5x8: 5 px). */
const DENSE_WIDTH = 312 * 5 + 8;   // 1568
const JB14_172_WIDTH = 172 * 9 + 8; // 1556

const FABLE_JB14 = { 'claude-fable-5': { historyStripCols: 172, historyStyle: { font: 'jetbrains-mono-14' } } };

/** Width/height from the PNG IHDR chunk (bytes 16..24, big-endian). */
function pngDims(b64: string): { width: number; height: number } {
  const bytes = Buffer.from(b64, 'base64');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** The transform learns the model only from its options (library.ts passes
 *  `model` through); the body's `model` field is not consulted. */
/** Lines wider than any column count under test, so the page runs full width. */
function wideLines(n: number, tag: string): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`${tag} line ${String(i).padStart(4, '0')} ` + 'abcdef0123456789 '.repeat(24));
  return out.join('\n');
}

function toolRound(id: string, body: string): Message[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { path: 'notes.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: body }] },
  ] as unknown as Message[];
}

function bodyWithLiveToolResult(model: string) {
  return enc({
    model,
    max_tokens: 1024,
    system: [{ type: 'text', text: 'SLAB\n' + 'x'.repeat(80_000), cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: 'go' },
      ...toolRound('t_live', 'RESULT t_live\n' + wideLines(120, 'tool')),
    ],
  });
}

/** Claude Code >= 2.1.281 thread continuation: system is only the billing line
 *  (no slab to image), the body is a large tool_result. This takes the early
 *  exit in runHistoryCollapseAndFinalize, a separate call site from the main path. */
function bodyWithTinySystemAndToolResult(model: string) {
  return enc({
    model,
    max_tokens: 1024,
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc' }],
    messages: [
      { role: 'user', content: 'go' },
      ...toolRound('t_cont', 'RESULT t_cont\n' + wideLines(120, 'tool')),
    ],
  });
}

/** Images nested in tool_result blocks, in wire order. */
function toolResultImageDims(out: Uint8Array): Array<{ width: number; height: number }> {
  const dims: Array<{ width: number; height: number }> = [];
  for (const m of dec(out).messages as any[]) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b?.type !== 'tool_result' || !Array.isArray(b.content)) continue;
      for (const ib of b.content) if (ib?.type === 'image') dims.push(pngDims(ib.source.data));
    }
  }
  return dims;
}

/** A collapsing history whose oldest user turn is a pasted document past the
 *  2000-char text cap, so the collapse renders it as its own image. */
function bodyWithOverCapUserTurn(model: string) {
  const bulk = 'window 0 train 2024-01-15 test breakout+htf @240m d10 seed 780 bars, eligibility ok. ';
  const messages: any[] = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [{ type: 'text', text: 'PASTED\n' + wideLines(40, 'doc') }] },
  ];
  for (let i = 0; i < 60; i++) {
    messages.push({ role: i % 2 === 0 ? 'assistant' : 'user', content: [{ type: 'text', text: bulk.repeat(40) + ` turn ${i}` }] });
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: 'continue' }] });
  return enc({
    model,
    max_tokens: 1024,
    system: [{ type: 'text', text: 'You are a coding agent. '.repeat(500), cache_control: { type: 'ephemeral' } }],
    messages,
  });
}

/** The image block(s) that immediately follow the over-cap user-turn notice. */
function overCapUserTurnImageDims(out: Uint8Array): Array<{ width: number; height: number }> {
  const dims: Array<{ width: number; height: number }> = [];
  for (const m of dec(out).messages as any[]) {
    if (!Array.isArray(m.content)) continue;
    let armed = false;
    for (const b of m.content) {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.includes('too long to carry as text')) { armed = true; continue; }
      if (armed && b?.type === 'image') { dims.push(pngDims(b.source.data)); continue; }
      armed = false;
    }
  }
  return dims;
}

beforeEach(() => { resetSessionState(); process.env[MODELS] = 'claude-opus-5,claude-fable-5'; });
afterEach(() => { delete process.env[ENV]; delete process.env[MODELS]; });

describe('tool_result pages follow the model history profile', () => {
  it('stays at the dense geometry without a profile (Fable default)', async () => {
    const { body: out, info } = await transformRequest(bodyWithLiveToolResult('claude-fable-5'), { model: 'claude-fable-5' });
    expect(info.toolResultImgs ?? 0, 'fixture must image the tool result').toBeGreaterThan(0);
    const dims = toolResultImageDims(out);
    expect(dims.length).toBe(info.toolResultImgs);
    // Bare 8 px rows: (height - 8) is a multiple of 8 but not of 10.
    for (const d of dims) { expect(d.width).toBe(DENSE_WIDTH); expect((d.height - 8) % 8).toBe(0); }
  });

  it('renders at jetbrains-mono-14 / 172 when the profile says so', async () => {
    process.env[ENV] = JSON.stringify(FABLE_JB14);
    const { body: out, info } = await transformRequest(bodyWithLiveToolResult('claude-fable-5'), { model: 'claude-fable-5' });
    expect(info.toolResultImgs ?? 0, 'fixture must image the tool result').toBeGreaterThan(0);
    const dims = toolResultImageDims(out);
    expect(dims.length).toBe(info.toolResultImgs);
    for (const d of dims) {
      expect(d.width).toBe(JB14_172_WIDTH);
      // The no-resize page limit must still hold at the taller font.
      expect(d.height).toBeLessThanOrEqual(728);
    }
  });

  it('also on the small-system early exit (thread continuation shape)', async () => {
    process.env[ENV] = JSON.stringify(FABLE_JB14);
    const { body: out, info } = await transformRequest(bodyWithTinySystemAndToolResult('claude-fable-5'), { model: 'claude-fable-5' });
    expect(info.toolResultImgs ?? 0, 'fixture must image the tool result').toBeGreaterThan(0);
    expect(info.collapsedImages ?? 0, 'fixture must NOT take the slab path').toBe(0);
    const dims = toolResultImageDims(out);
    expect(dims.length).toBe(info.toolResultImgs);
    for (const d of dims) expect(d.width).toBe(JB14_172_WIDTH);
  });

  it('a caller-supplied cols still wins over the profile (no-resize guard)', async () => {
    process.env[ENV] = JSON.stringify({ 'claude-fable-5': { historyStripCols: 999, historyStyle: { font: 'jetbrains-mono-14' } } });
    const { body: out, info } = await transformRequest(bodyWithLiveToolResult('claude-fable-5'), { model: 'claude-fable-5', cols: 172 });
    expect(info.toolResultImgs ?? 0).toBeGreaterThan(0);
    // Not merely "fits": 172 cols at the 9 px jb-14 cell. A fallback to dense
    // 312/spleen would also fit (1568) and must not pass here.
    for (const d of toolResultImageDims(out)) expect(d.width).toBe(JB14_172_WIDTH);
  });
});

describe('shipped Opus default (no env profile): spaced 5x8 rows, not bare', () => {
  // Opus/Sonnet/Haiku ship historyStyle = spaced 5x8 (cellHBonus 2). Before
  // 2026-10-19 tool_result pages and over-cap user turns ignored it and drew
  // bare 8 px rows; now they follow the same readable geometry as the transcript.
  // Width cannot tell the two apart (both 1568 at 312 cols); row pitch can:
  // page height = 8 px border + rows x 10 px (spaced) vs rows x 8 px (bare).
  const spaced = (h: number) => (h - 8) % 10 === 0;
  it('tool_result pages', async () => {
    const { body: out, info } = await transformRequest(bodyWithLiveToolResult('claude-opus-5'), { model: 'claude-opus-5' });
    expect(info.toolResultImgs ?? 0).toBeGreaterThan(0);
    const dims = toolResultImageDims(out);
    expect(dims.length).toBe(info.toolResultImgs);
    for (const d of dims) { expect(d.width).toBe(DENSE_WIDTH); expect(spaced(d.height), `height ${d.height}`).toBe(true); }
  });
  it('over-cap user turns', async () => {
    const { body: out, info } = await transformRequest(bodyWithOverCapUserTurn('claude-opus-5'), { model: 'claude-opus-5' });
    expect(info.collapsedTurns ?? 0).toBeGreaterThan(0);
    const dims = overCapUserTurnImageDims(out);
    expect(dims.length).toBeGreaterThan(0);
    for (const d of dims) { expect(d.width).toBe(DENSE_WIDTH); expect(spaced(d.height), `height ${d.height}`).toBe(true); }
  });
});

describe('over-cap user turns inside the collapse follow the model history profile', () => {
  it('stays at the dense geometry without a profile (Fable default)', async () => {
    const { body: out, info } = await transformRequest(bodyWithOverCapUserTurn('claude-fable-5'), { model: 'claude-fable-5' });
    expect(info.collapsedTurns ?? 0, 'fixture must collapse').toBeGreaterThan(0);
    const dims = overCapUserTurnImageDims(out);
    expect(dims.length, 'the pasted turn must be rendered as its own image').toBeGreaterThan(0);
    for (const d of dims) expect(d.width).toBe(DENSE_WIDTH);
  });

  it('renders at jetbrains-mono-14 / 172 when the profile says so', async () => {
    process.env[ENV] = JSON.stringify(FABLE_JB14);
    const { body: out, info } = await transformRequest(bodyWithOverCapUserTurn('claude-fable-5'), { model: 'claude-fable-5' });
    expect(info.collapsedTurns ?? 0, 'fixture must collapse').toBeGreaterThan(0);
    const dims = overCapUserTurnImageDims(out);
    expect(dims.length, 'the pasted turn must be rendered as its own image').toBeGreaterThan(0);
    for (const d of dims) {
      expect(d.width).toBe(JB14_172_WIDTH);
      expect(d.height).toBeLessThanOrEqual(728);
    }
  });
});
