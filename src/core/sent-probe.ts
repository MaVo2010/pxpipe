/**
 * Third count_tokens probe: the body pxpipe actually sends, with pxpipe's own
 * rendered images taken out. count_tokens on it counts the sent text; the
 * removed images are priced locally from their PNG header (pxpipe rendered
 * them, so the size is exact). Billed input minus (this count + image cost) is
 * what the provider bills but count_tokens does not see: on claude-opus-5-5 and
 * claude-fable-5-1 the thinking blocks of earlier replies.
 *
 * pxpipe's images are the image blocks whose base64 data occurs nowhere in the
 * ORIGINAL body. Client images (screenshots, pasted images) therefore stay in
 * the probe, and pxpipe's PNGs never need re-encoding (that costs ~200 ms per
 * request; this is a string-set lookup).
 *
 * Pure: no fetch, no Node APIs (runs on Workers too).
 * Design: docs/superpowers/specs/2026-10-07-thinking-baseline-floor-design.md
 */
import { anthropicVisionTokens } from './anthropic-vision.js';
import { pickCountTokensFields } from './measurement.js';

export interface SentCountTokensBody {
  /** count_tokens request body (accepted fields only), pxpipe images removed. */
  body: Uint8Array;
  /** `model` of the sent body; selects the vision tier for image pricing. */
  model: string;
  /** Width/height of every removed pxpipe image, in body order (system, then messages). */
  removedImageDims: Array<{ width: number; height: number }>;
}

export interface SentProbeResult {
  countTokens: number;
  imageTokensEst: number;
}

type Block = Record<string, unknown>;

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width/height from a base64 PNG's IHDR (bytes 16..23). Decodes 32 base64
 *  chars only. Null when the data is not a PNG. */
export function pngDimsFromBase64(b64: string): { width: number; height: number } | null {
  if (b64.length < 32) return null;
  let bin: string;
  try {
    bin = atob(b64.slice(0, 32));
  } catch {
    return null;
  }
  for (let i = 0; i < 8; i++) if (bin.charCodeAt(i) !== PNG_SIG[i]) return null;
  if (bin.slice(12, 16) !== 'IHDR') return null;
  const u32 = (i: number) =>
    ((bin.charCodeAt(i) << 24) >>> 0) +
    (bin.charCodeAt(i + 1) << 16) +
    (bin.charCodeAt(i + 2) << 8) +
    bin.charCodeAt(i + 3);
  return { width: u32(16), height: u32(20) };
}

function base64ImageData(b: unknown): string | null {
  if (!b || typeof b !== 'object') return null;
  const blk = b as Block;
  if (blk.type !== 'image') return null;
  const src = blk.source as Block | undefined;
  if (!src || src.type !== 'base64' || typeof src.data !== 'string') return null;
  return src.data;
}

/** Every base64 image payload anywhere in `v` (system, messages, tool_result content). */
function collectImageData(v: unknown, into: Set<string>): void {
  if (Array.isArray(v)) {
    for (const x of v) collectImageData(x, into);
    return;
  }
  if (!v || typeof v !== 'object') return;
  const d = base64ImageData(v);
  if (d !== null) {
    into.add(d);
    return;
  }
  for (const x of Object.values(v as Block)) collectImageData(x, into);
}

/** Drop pxpipe images from a block list, recursing into tool_result content.
 *  A list emptied by the removal gets one "." text block so the body stays valid. */
function stripBlocks(
  blocks: unknown[],
  client: Set<string>,
  dims: SentCountTokensBody['removedImageDims'],
): unknown[] {
  const out: unknown[] = [];
  for (const b of blocks) {
    const data = base64ImageData(b);
    if (data !== null && !client.has(data)) {
      const d = pngDimsFromBase64(data);
      if (d) {
        dims.push(d);
        continue;
      }
      // Not a PNG and not from the client: keep it. count_tokens prices it, so S
      // only gets smaller (stays a lower bound).
    }
    if (b && typeof b === 'object' && (b as Block).type === 'tool_result' && Array.isArray((b as Block).content)) {
      out.push({ ...(b as Block), content: stripBlocks((b as Block).content as unknown[], client, dims) });
      continue;
    }
    out.push(b);
  }
  return out.length > 0 || blocks.length === 0 ? out : [{ type: 'text', text: '.' }];
}

export function buildSentCountTokensBody(original: Uint8Array, sent: Uint8Array): SentCountTokensBody | null {
  try {
    const dec = new TextDecoder();
    const orig = JSON.parse(dec.decode(original)) as Block;
    const obj = JSON.parse(dec.decode(sent)) as Block;
    const client = new Set<string>();
    collectImageData(orig.system, client);
    collectImageData(orig.messages, client);
    const removedImageDims: SentCountTokensBody['removedImageDims'] = [];
    if (Array.isArray(obj.system)) obj.system = stripBlocks(obj.system, client, removedImageDims);
    if (Array.isArray(obj.messages)) {
      obj.messages = (obj.messages as unknown[]).map((m) => {
        if (!m || typeof m !== 'object' || !Array.isArray((m as Block).content)) return m;
        return { ...(m as Block), content: stripBlocks((m as Block).content as unknown[], client, removedImageDims) };
      });
    }
    const picked = pickCountTokensFields(obj);
    if (!picked) return null;
    return {
      body: new TextEncoder().encode(JSON.stringify(picked)),
      model: picked.model as string,
      removedImageDims,
    };
  } catch {
    return null;
  }
}

/** Anthropic cost of the removed images (28-px patches, the model's vision tier). */
export function estimateImageTokens(
  model: string,
  dims: ReadonlyArray<{ width: number; height: number }>,
): number {
  let n = 0;
  for (const d of dims) n += anthropicVisionTokens(model, d.width, d.height);
  return n;
}
