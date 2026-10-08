import { describe, expect, it } from 'vitest';
import {
  buildSentCountTokensBody,
  estimateImageTokens,
  pngDimsFromBase64,
} from '../src/core/sent-probe.js';
import { anthropicVisionTokens } from '../src/core/anthropic-vision.js';

/** Base64 of a PNG header (signature + IHDR) for a w×h image. Enough for the
 *  dims parser; `tag` fills bytes 33-36 (after the IHDR CRC) so payloads differ. */
function pngB64(w: number, h: number, tag = 0): string {
  const b = new Uint8Array(37);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13], 8);
  b.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  b.set([8, 2, 0, 0, 0], 24);
  dv.setUint32(33, tag);
  return Buffer.from(b).toString('base64');
}

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const dec = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));
const img = (data: string, media_type = 'image/png') => ({
  type: 'image',
  source: { type: 'base64', media_type, data },
});

const CLIENT = pngB64(640, 480, 99);
const P1 = pngB64(1568, 728, 1);
const P2 = pngB64(1568, 23, 2);
const THINK = { type: 'thinking', thinking: 'hmm', signature: 's1' };

const original = {
  model: 'claude-opus-5-5',
  max_tokens: 64,
  stream: true,
  system: [{ type: 'text', text: 'SLAB '.repeat(1000), cache_control: { type: 'ephemeral' } }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'look' }, img(CLIENT)] },
    { role: 'assistant', content: [THINK, { type: 'tool_use', id: 't1', name: 'Read', input: { p: 1 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'RESULT '.repeat(500) }] },
  ],
};
// What pxpipe forwards: slab imaged away, a history page, a tool result imaged.
const sent = {
  ...original,
  system: [img(P1)],
  messages: [
    { role: 'user', content: [img(P2), { type: 'text', text: 'look' }, img(CLIENT)] },
    original.messages[1],
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [img(P1)] }] },
  ],
};

describe('pngDimsFromBase64', () => {
  it('reads width and height from the IHDR', () => {
    expect(pngDimsFromBase64(P1)).toEqual({ width: 1568, height: 728 });
    expect(pngDimsFromBase64(P2)).toEqual({ width: 1568, height: 23 });
  });
  it('returns null for non-PNG and too-short data', () => {
    expect(pngDimsFromBase64('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgH')).toBeNull();
    expect(pngDimsFromBase64('iVBORw0K')).toBeNull();
  });
});

describe('buildSentCountTokensBody', () => {
  it('removes pxpipe images everywhere, keeps the client image, prices each removed one', () => {
    const r = buildSentCountTokensBody(enc(original), enc(sent))!;
    const out = dec(r.body);
    const s = JSON.stringify(out);
    expect(s).not.toContain(P1);
    expect(s).not.toContain(P2);
    expect(s).toContain(CLIENT);
    expect(out.system).toEqual([{ type: 'text', text: '.' }]);
    expect(out.messages[0].content).toEqual([{ type: 'text', text: 'look' }, img(CLIENT)]);
    expect(out.messages[2].content[0].content).toEqual([{ type: 'text', text: '.' }]);
    // system first, then messages in order; P1 occurs twice and is priced twice
    expect(r.removedImageDims).toEqual([
      { width: 1568, height: 728 },
      { width: 1568, height: 23 },
      { width: 1568, height: 728 },
    ]);
    expect(r.model).toBe('claude-opus-5-5');
  });

  it('keeps thinking blocks untouched (count_tokens must see what the provider bills)', () => {
    const out = dec(buildSentCountTokensBody(enc(original), enc(sent))!.body);
    expect(out.messages[1]).toEqual(original.messages[1]);
  });

  it('keeps a client JPEG that is not in pxpipe images (non-PNG is never priced)', () => {
    const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U';
    const o = { ...original, messages: [{ role: 'user', content: [img(jpeg, 'image/jpeg')] }] };
    const s2 = { ...o, system: [img(P1)] };
    const r = buildSentCountTokensBody(enc(o), enc(s2))!;
    expect(JSON.stringify(dec(r.body))).toContain(jpeg);
    expect(r.removedImageDims).toEqual([{ width: 1568, height: 728 }]);
  });

  it('keeps a JPEG that is only in the sent body (not PNG, not from the client); removes the pxpipe PNG', () => {
    const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U';
    const o = { ...original, messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }] }] };
    const s2 = {
      ...o,
      messages: [{ role: 'user', content: [img(P2), { type: 'text', text: 'look' }, img(jpeg, 'image/jpeg')] }],
    };
    const r = buildSentCountTokensBody(enc(o), enc(s2))!;
    const out = dec(r.body);
    expect(JSON.stringify(out)).not.toContain(P2);
    expect(out.messages[0].content).toEqual([{ type: 'text', text: 'look' }, img(jpeg, 'image/jpeg')]);
    expect(r.removedImageDims).toEqual([{ width: 1568, height: 23 }]);
  });

  it('drops fields count_tokens rejects', () => {
    const out = dec(buildSentCountTokensBody(enc(original), enc(sent))!.body);
    expect(out.max_tokens).toBeUndefined();
    expect(out.stream).toBeUndefined();
    expect(out.model).toBe('claude-opus-5-5');
  });

  it('leaves an unchanged body unchanged and prices nothing', () => {
    const r = buildSentCountTokensBody(enc(original), enc(original))!;
    expect(r.removedImageDims).toEqual([]);
    expect(dec(r.body).messages).toEqual(original.messages);
  });

  it('returns null on an unparsable body', () => {
    expect(buildSentCountTokensBody(enc(original), new TextEncoder().encode('{nope'))).toBeNull();
  });
});

describe('estimateImageTokens', () => {
  it('sums the 28-px patch cost of every removed image', () => {
    const dims = [{ width: 1568, height: 728 }, { width: 1568, height: 23 }];
    const want = dims.reduce((a, d) => a + anthropicVisionTokens('claude-opus-5-5', d.width, d.height), 0);
    expect(estimateImageTokens('claude-opus-5-5', dims)).toBe(want);
    expect(estimateImageTokens('claude-opus-5-5', [{ width: 1568, height: 728 }])).toBe(56 * 26);
  });
});
