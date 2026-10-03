/**
 * Choosing the scanline filter per row makes pages lighter without touching a pixel.
 *
 * Every page used to go out with PNG's Average filter on every row. That suits
 * 1-bit 5x8 glyphs on a flat ground; it does not suit the antialiased, role-tinted
 * RGB pages of the legible history profile, which are the heaviest pages pxpipe
 * sends and the ones that hit the 18 MiB byte budget first. Measured 2026-10-03 on
 * 587 real history pages from a production image ring: choosing among all five
 * filters per row (minimum sum of absolute residuals, the libpng heuristic) at the
 * same deflate level took them to 75% of their size, pixel for pixel identical.
 * Raising the deflate level instead bought 2%.
 *
 * What matters, in order:
 *  - the decoded pixels are exactly the rendered ones (skia decodes, see
 *    png-lossless.test.ts for why not a hand-rolled decoder);
 *  - the bytes are a pure function of the pixels, or every history chunk re-keys
 *    the provider's prompt cache on every turn;
 *  - real pages get lighter. Vision tokens are priced by pixel dimensions, so this
 *    is free room under the byte budget, not a cost trade.
 *
 * Run just this file:  pnpm vitest run tests/png-adaptive-filter.test.ts
 */
import { inflateSync, deflateSync } from 'node:zlib';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { encodeGrayPng, encodeRgbPng } from '../src/core/png.js';
import { collapseHistory } from '../src/core/history.js';
import {
  DENSE_CONTENT_CHARS_PER_IMAGE,
  DENSE_CONTENT_COLS,
  DENSE_RENDER_STYLE,
  MAX_HEIGHT_PX,
  maxCharsPerImage,
  renderTextToPngsWithCharLimit,
} from '../src/core/render.js';
import type { Message } from '../src/core/types.js';

const WORDS = [
  'order', 'window', 'latency', 'buffer', 'ledger', 'margin', 'signal', 'replay',
  'socket', 'cursor', 'bucket', 'stream', 'anchor', 'digest', 'format', 'kernel',
  'packet', 'review', 'series', 'thread', 'update', 'vector', 'worker', 'zone',
  'because', 'therefore', 'measured', 'against', 'before', 'after', 'never', 'always',
];
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

async function decode(png: Uint8Array): Promise<{ rgba: Uint8ClampedArray; w: number; h: number }> {
  const img = await loadImage(Buffer.from(png));
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { rgba: ctx.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height };
}
const channels = (rgba: Uint8ClampedArray, n: 1 | 3): Uint8Array => {
  const out = new Uint8Array((rgba.length / 4) * n);
  for (let i = 0; i < rgba.length / 4; i++) for (let c = 0; c < n; c++) out[i * n + c] = rgba[i * 4 + c]!;
  return out;
};

/** The encoding every page used to get: Average on every row, default deflate level. */
function averageReference(pixels: Uint8Array, w: number, h: number, bpp: number): number {
  const row = w * bpp;
  const out = new Uint8Array((row + 1) * h);
  for (let y = 0; y < h; y++) {
    out[y * (row + 1)] = 3;
    for (let x = 0; x < row; x++) {
      const a = x >= bpp ? pixels[y * row + x - bpp]! : 0;
      const b = y > 0 ? pixels[(y - 1) * row + x]! : 0;
      out[y * (row + 1) + 1 + x] = (pixels[y * row + x]! - ((a + b) >> 1)) & 0xff;
    }
  }
  return deflateSync(out).length;
}

/** IDAT payload and the filter byte of every scanline. */
function scanlines(png: Uint8Array, bpp: number): { idat: number; filters: number[] } {
  const b = Buffer.from(png);
  const w = b.readUInt32BE(16);
  const parts: Buffer[] = [];
  for (let p = 8; p < b.length; ) {
    const len = b.readUInt32BE(p);
    if (b.toString('ascii', p + 4, p + 8) === 'IDAT') parts.push(b.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const idat = Buffer.concat(parts);
  const raw = inflateSync(idat);
  const stride = w * bpp + 1;
  const filters: number[] = [];
  for (let o = 0; o < raw.length; o += stride) filters.push(raw[o]!);
  return { idat: idat.length, filters };
}

/** History pages as the legible profile renders them: RGB, role-tinted, antialiased. */
async function legibleHistoryPages(): Promise<Uint8Array[]> {
  const msgs: Message[] = [];
  for (let i = 0; i < 64; i++) {
    msgs.push(i % 2 === 0 ? { role: 'user', content: `question ${i}` } : { role: 'assistant', content: `answer ${i}: ` + prose(i, 1500) });
  }
  const { info } = await collapseHistory(msgs, () => true, {
    cols: 172,
    style: { font: 'jetbrains-mono-14', cellHBonus: 2, aa: true },
    maxHeightPx: MAX_HEIGHT_PX,
    pageChars: maxCharsPerImage(172),
    imageBudget: 0,
  });
  return info.collapsedPngs;
}

describe('pixels are untouched', () => {
  it('decodes real history pages to exactly the pixels that went in', async () => {
    const pages = await legibleHistoryPages();
    expect(pages.length).toBeGreaterThan(1);
    for (const png of pages.slice(0, 3)) {
      const first = await decode(png);
      const rgb = channels(first.rgba, 3);
      const again = await decode(await encodeRgbPng(rgb, first.w, first.h));
      expect(Buffer.from(channels(again.rgba, 3)).equals(Buffer.from(rgb))).toBe(true);
    }
  }, 60_000);

  it('produces the same bytes for the same pixels', async () => {
    const [png] = await legibleHistoryPages();
    const { rgba, w, h } = await decode(png!);
    const rgb = channels(rgba, 3);
    const a = await encodeRgbPng(rgb, w, h);
    const b = await encodeRgbPng(rgb, w, h);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  }, 60_000);
});

describe('real pages get lighter', () => {
  it('weighs legible RGB history pages at well under the Average filter', async () => {
    const pages = await legibleHistoryPages();
    let ours = 0;
    let reference = 0;
    for (const png of pages) {
      const { rgba, w, h } = await decode(png);
      const rgb = channels(rgba, 3);
      ours += scanlines(await encodeRgbPng(rgb, w, h), 3).idat;
      reference += averageReference(rgb, w, h, 3);
    }
    // Measured 75% on production pages; the bound leaves room for fixture drift.
    expect(ours / reference).toBeLessThan(0.85);
  }, 60_000);

  it('chooses the filter per row instead of using one for all', async () => {
    const [png] = await legibleHistoryPages();
    const { rgba, w, h } = await decode(png!);
    const { filters } = scanlines(await encodeRgbPng(channels(rgba, 3), w, h), 3);
    expect(new Set(filters).size).toBeGreaterThan(1);
    for (const f of filters) expect(f).toBeGreaterThanOrEqual(0), expect(f).toBeLessThanOrEqual(4);
  }, 60_000);

  it('never makes a grayscale slab page heavier', async () => {
    const [page] = await renderTextToPngsWithCharLimit(
      prose(7, 20_000),
      DENSE_CONTENT_COLS,
      DENSE_CONTENT_CHARS_PER_IMAGE,
      DENSE_RENDER_STYLE,
    );
    const { rgba, w, h } = await decode(page!.png);
    const gray = channels(rgba, 1);
    const ours = scanlines(await encodeGrayPng(gray, w, h), 1).idat;
    expect(ours).toBeLessThanOrEqual(averageReference(gray, w, h, 1));
  }, 60_000);
});
