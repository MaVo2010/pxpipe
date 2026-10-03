/**
 * Minimal PNG encoder (grayscale + RGB, 8-bit, filter chosen per row, single IDAT).
 * Pure Uint8Array — uses CompressionStream (Node 18+, Workers, browsers); no Buffer/node:zlib.
 */

// ---- CRC32 ---------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- Helpers -------------------------------------------------------------

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

const TYPE_BYTES = (s: string): Uint8Array => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
};

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeB = TYPE_BYTES(type);
  const crcSrc = concat([typeB, data]);
  return concat([u32be(data.length), typeB, data, u32be(crc32(crcSrc))]);
}

// ---- Deflate via Web Streams ---------------------------------------------

async function deflateZlib(input: Uint8Array): Promise<Uint8Array> {
  // 'deflate' = RFC 1950 zlib-wrapped — what PNG IDAT needs. 'deflate-raw' (RFC 1951) would be wrong.
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  // TS 5.7 narrows Uint8Array<ArrayBufferLike> away from BufferSource; safe since we never use SharedArrayBuffer.
  void writer.write(input as Uint8Array<ArrayBuffer>);
  void writer.close();

  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return concat(chunks);
}

// ---- Encode --------------------------------------------------------------

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Prepend PNG's Average filter (type 3) to every row:
 *   Filt(x) = Orig(x) − floor((Recon(a) + Recon(b)) / 2)
 * with `a` the same channel one pixel left and `b` the byte above, zero off-image. Bit-exact
 * reversible for the same reason as {@link filterAdaptive}. Kept as the grayscale fallback:
 * it suits 1-bit 5×8 glyphs on a flat ground, where it can beat the per-row heuristic.
 */
function filterAverage(pixels: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const rowBytes = width * bpp;
  const stride = rowBytes + 1;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const src = y * rowBytes;
    const dst = y * stride;
    out[dst] = 3;
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? pixels[src + x - bpp]! : 0;
      const b = y > 0 ? pixels[src - rowBytes + x]! : 0;
      // a + b ≤ 510 so the shift is exact; only the result wraps to a byte.
      out[dst + 1 + x] = (pixels[src + x]! - ((a + b) >> 1)) & 0xff;
    }
  }
  return out;
}

/** PNG's Paeth predictor: whichever of left, up, upper-left is closest to left + up − upper-left. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** A residual weighed as a signed byte: 0xff is −1, a near miss, not a large error. */
function residualCost(r: number): number {
  return r < 128 ? r : 256 - r;
}

/**
 * Prepend scanline filter bytes, choosing the filter per row: None, Sub, Up, Average or Paeth,
 * whichever leaves the smallest sum of absolute residuals (read as signed bytes). That is
 * libpng's own heuristic. `a` is the same channel of the pixel to the left (x − bpp), `b` the
 * byte directly above, `c` the byte above-left; off-image neighbours are zero by the spec.
 * Encoding may read the ORIGINAL bytes for them because the decoder reconstructs those positions
 * exactly before it needs them, so every filter is bit-exact reversible and decoded pixels are
 * byte-identical to `pixels`. Nothing about the image the model sees changes.
 *
 * Average on every row (the previous behaviour) suits 1-bit 5×8 glyphs on a flat ground. It does
 * not suit antialiased, role-tinted RGB history pages, the heaviest pages pxpipe sends and the
 * ones that fill the byte budget first: on 587 such pages from a production image ring the
 * per-row choice took the IDAT to 75% at the same deflate level (raising the level instead
 * bought 2%). Vision tokens are priced by pixel dimensions, so the saving is free room under the
 * byte budget. Choosing is pure JS ahead of the compressor, so it stays portable to Workers
 * unlike a deflate-level change (see the CompressionStream note above), and it is deterministic,
 * which the prompt cache depends on: same pixels, same bytes.
 */
function filterAdaptive(pixels: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const rowBytes = width * bpp;
  const stride = rowBytes + 1;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const src = y * rowBytes;
    const up = src - rowBytes;
    // One pass prices all five filters; the second writes only the winner.
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
    for (let x = 0; x < rowBytes; x++) {
      const v = pixels[src + x]!;
      const a = x >= bpp ? pixels[src + x - bpp]! : 0;
      const b = y > 0 ? pixels[up + x]! : 0;
      const c = x >= bpp && y > 0 ? pixels[up + x - bpp]! : 0;
      s0 += residualCost(v);
      s1 += residualCost((v - a) & 0xff);
      s2 += residualCost((v - b) & 0xff);
      // a + b ≤ 510 so the shift is exact; only the result wraps to a byte.
      s3 += residualCost((v - ((a + b) >> 1)) & 0xff);
      s4 += residualCost((v - paeth(a, b, c)) & 0xff);
    }
    // Ties go to the lower filter number, so the choice is a pure function of the row.
    let f = 0;
    let best = s0;
    if (s1 < best) { f = 1; best = s1; }
    if (s2 < best) { f = 2; best = s2; }
    if (s3 < best) { f = 3; best = s3; }
    if (s4 < best) { f = 4; best = s4; }
    const dst = y * stride;
    out[dst] = f;
    for (let x = 0; x < rowBytes; x++) {
      const v = pixels[src + x]!;
      const a = x >= bpp ? pixels[src + x - bpp]! : 0;
      const b = y > 0 ? pixels[up + x]! : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) pred = paeth(a, b, x >= bpp && y > 0 ? pixels[up + x - bpp]! : 0);
      out[dst + 1 + x] = (v - pred) & 0xff;
    }
  }
  return out;
}

/** Encode a single-channel (grayscale) buffer as PNG bytes. pixels is row-major, length = width × height. */
export async function encodeGrayPng(pixels: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  if (pixels.length !== width * height) {
    throw new Error(`encodeGrayPng: pixels.length=${pixels.length} != ${width}×${height}=${width * height}`);
  }

  // IHDR: width(4) height(4) bitDepth=8 colorType=0(gray) compress=0 filter=0 interlace=0
  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(width), 0);
  ihdr.set(u32be(height), 4);
  ihdr[8] = 8;
  ihdr[9] = 0; // colorType 0 = grayscale; bytes 10-12 already zero

  // Grayscale pages are compressed both ways and the smaller wins. On 213 real slab pages the
  // per-row choice was never heavier (72–85% of Average), but a page of uniform prose in 5×8
  // came out 3.7% heavier, and the heuristic ranks residuals, not deflate output. A gray page is
  // a fraction of an RGB one, so the second pass is cheap insurance; ties keep Average.
  const [average, adaptive] = await Promise.all([
    deflateZlib(filterAverage(pixels, width, height, 1)),
    deflateZlib(filterAdaptive(pixels, width, height, 1)),
  ]);
  const compressed = adaptive.length < average.length ? adaptive : average;

  return concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Encode an RGB (3 bytes/pixel, R,G,B) buffer as PNG bytes (colorType 2 = truecolor). length = width × height × 3. */
export async function encodeRgbPng(pixels: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  if (pixels.length !== width * height * 3) {
    throw new Error(`encodeRgbPng: pixels.length=${pixels.length} != ${width}×${height}×3=${width * height * 3}`);
  }

  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(width), 0);
  ihdr.set(u32be(height), 4);
  ihdr[8] = 8; // bit depth per channel
  ihdr[9] = 2; // colorType 2 = truecolor RGB; bytes 10-12 already zero

  const compressed = await deflateZlib(filterAdaptive(pixels, width, height, 3));

  return concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Base64-encode bytes. Chunks to avoid call-stack blow-up from String.fromCharCode(...bigArray). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
