# Thinking-aware baseline floor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure the thinking tokens the provider bills but `count_tokens` does not count, and show a lower-bound corrected saving next to the unchanged dashboard headline.

**Architecture:** On compressed Anthropic requests the proxy fires a third `count_tokens` probe on the body it actually sends, minus its own rendered images (priced locally from their PNG header). Three measured fields go to the log. The dashboard and the long-run stats derive the surcharge S from them, add it to the baseline sizes and run the existing cache-aware formula unchanged.

**Tech Stack:** TypeScript (Node 24, also runs on Workers: no Node APIs in `src/core`), vitest, pnpm via corepack. Python 3 for the side-port trial and the live analysis.

**Spec:** `docs/superpowers/specs/2026-10-07-thinking-baseline-floor-design.md` (same branch). Executors read both.

## Global Constraints

- All code work happens in the worktree `W=/srv/pxpipe-worktrees/thinking-baseline-floor` on branch `feat/thinking-baseline-floor`. Nothing in `/srv/pxpipe` (the live checkout; the service runs `/srv/pxpipe/dist/node.js`) is edited or built before Task 8, and Task 8 only runs after the operator says go.
- Node and pnpm only as `env PATH=/opt/node-24/bin:$PATH corepack pnpm …`.
- Never `git add -A`; stage explicit paths. Never push.
- Check every exit code on its own line (`; echo "rc=$?"`); a pipe hides the left side's code.
- The headline number and every existing field and payload key stay unchanged. Only new fields are added.
- Third probe: every model, compressed Anthropic `/v1/messages` requests only. Uncompressed: status `skipped`, no extra request.
- Log field names, exact: `sent_count_tokens`, `sent_image_tokens_est`, `sent_probe_status` (`ok` / `failed` / `skipped`). `TransformInfo`: `sentCountTokens`, `sentImageTokensEst`, `sentProbeStatus`.
- `/proxy-stats` keys, exact: `baseline_input_weighted_thinking_min`, `saved_input_tokens_thinking_min`, `saved_pct_input_only_thinking_min`, `thinking_floor_measured_requests`, `thinking_floor_eligible_requests`.
- UI copy is English. Hero line, exact shape: `Counting earlier replies' thinking: at least 21% fewer · 1,412 of 1,430 imaged requests measured`.
- S is floored at 0 and is 0 when unmeasured, so the corrected number is a lower bound.
- Commit trailer on every commit:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01BTHhT9kQufnhcWf5kXS2ut`

## Deviation from the spec wording (agreed in the plan review)

The spec says the probe removes "the PNGs listed in `info.imagePngs`" and prices them from `info.imageDims`. Matching against `info.imagePngs` needs each PNG re-encoded to base64; measured on this host that costs about 210 ms for 80 pages of 78 KiB on the event loop. The plan instead treats an image block as pxpipe's when its base64 data does not occur anywhere in the original body, and reads width and height from the PNG header (32 base64 chars). Same set of images, same exact sizes, no re-encoding. The spec text is updated with the plan commit.

## Review Focus

1. **Streamed responses with a slow third probe.** Real traffic is SSE; the probe can resolve after the last byte went to the client. The event row must still carry `sent_probe_status: ok`. Test in Task 2 (Step 1, test "streamed response …").
2. **Client images that are not PNG (JPEG/WebP screenshots).** They must stay in the probe body and must not be priced as pxpipe images. Test in Task 1 (Step 2, test "keeps a client JPEG …").
3. **Baseline probe failed but third probe ok.** The row is not in the headline totals, so it must not enter the floor totals either (the floor must stay paired with `actual_input_weighted`). Test in Task 3 (Step 1, test "row without a usable baseline …").
4. **Service restart mid-session.** `replay()` rebuilds the per-session prior from the log. Without the S-inclusive prior the first warm request after a restart prices too much as newly cached, and the floor would overclaim. Test in Task 3 (Step 1, test "restart: replay restores …").
5. **Uncompressed row billed below its baseline** (count_tokens over-counts slightly). The long-run correction must add 0, never subtract. Test in Task 5 (Step 1, test "never subtracts …").

---

### Task 1: Sent-body probe builder

**Files:**
- Create: `src/core/sent-probe.ts`
- Modify: `src/core/measurement.ts:40-53` (extract `pickCountTokensFields`, reuse it in `buildBaselineCountTokensBody`)
- Test: `tests/sent-probe.test.ts`

**Interfaces:**
- Consumes: `anthropicVisionTokens(model, width, height): number` from `src/core/anthropic-vision.ts:40`.
- Produces:
  - `pickCountTokensFields(obj: Record<string, unknown>): Record<string, unknown> | null` (measurement.ts)
  - `pngDimsFromBase64(b64: string): { width: number; height: number } | null`
  - `buildSentCountTokensBody(original: Uint8Array, sent: Uint8Array): SentCountTokensBody | null`
  - `estimateImageTokens(model: string, dims: ReadonlyArray<{ width: number; height: number }>): number`
  - `interface SentCountTokensBody { body: Uint8Array; model: string; removedImageDims: Array<{ width: number; height: number }> }`
  - `interface SentProbeResult { countTokens: number; imageTokensEst: number }`

- [ ] **Step 1: Install deps in the worktree and record the green baseline**

```bash
W=/srv/pxpipe-worktrees/thinking-baseline-floor; cd $W
env PATH=/opt/node-24/bin:$PATH corepack pnpm install --frozen-lockfile; echo "install rc=$?"
env PATH=/opt/node-24/bin:$PATH corepack pnpm vitest run 2>&1 | tail -5; echo "test rc=${PIPESTATUS[0]}"
env PATH=/opt/node-24/bin:$PATH corepack pnpm typecheck; echo "typecheck rc=$?"
```

Expected: all three rc=0. Write down the test and file counts from the vitest summary; Task 6 compares against them.

- [ ] **Step 2: Write the failing tests**

Create `tests/sent-probe.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildSentCountTokensBody,
  estimateImageTokens,
  pngDimsFromBase64,
} from '../src/core/sent-probe.js';
import { anthropicVisionTokens } from '../src/core/anthropic-vision.js';

/** Base64 of a PNG header (signature + IHDR) for a w×h image. Enough for the
 *  dims parser; `tag` fills the CRC slot so payloads differ. */
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd $W && env PATH=/opt/node-24/bin:$PATH corepack pnpm vitest run tests/sent-probe.test.ts; echo "rc=$?"`
Expected: FAIL, "Failed to resolve import ../src/core/sent-probe.js", rc≠0.

- [ ] **Step 4: Extract `pickCountTokensFields` in `src/core/measurement.ts`**

Replace the body of `buildBaselineCountTokensBody` (lines 40-53) with:

```ts
/** Keep only the fields /v1/messages/count_tokens accepts. Null when the result
 *  lacks a string `model` or a `messages` array (the endpoint would 400). */
export function pickCountTokensFields(obj: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    if (COUNT_TOKENS_FIELDS.has(k)) out[k] = obj[k];
  }
  if (typeof out.model !== 'string' || !Array.isArray(out.messages)) return null;
  return out;
}

export function buildBaselineCountTokensBody(bytes: BytesLike): Uint8Array | null {
  const b = toUint8Array(bytes);
  try {
    const obj = JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>;
    const out = pickCountTokensFields(obj);
    if (!out) return null;
    return new TextEncoder().encode(JSON.stringify(out));
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Create `src/core/sent-probe.ts`**

```ts
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
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd $W && env PATH=/opt/node-24/bin:$PATH corepack pnpm vitest run tests/sent-probe.test.ts tests/proxy-usage.test.ts tests/savings-math-e2e.test.ts; echo "rc=$?"`
Expected: PASS, rc=0 (the two existing files prove the `pickCountTokensFields` refactor kept the baseline probe body).

- [ ] **Step 7: Commit**

```bash
cd $W && git add src/core/sent-probe.ts src/core/measurement.ts tests/sent-probe.test.ts && git commit -q -F - <<'EOF'; echo "rc=$?"
feat(measurement): build the sent-body count_tokens probe without pxpipe images

pxpipe images are the image blocks whose data is not in the original body;
their size comes from the PNG header, so nothing is re-encoded. Client
images and thinking blocks stay in the probe.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BTHhT9kQufnhcWf5kXS2ut
EOF
```

---

### Task 2: Third probe in the proxy and the three log fields

**Files:**
- Modify: `src/core/transform.ts:841` (three `TransformInfo` fields after `baselineProbeStatus`)
- Modify: `src/core/tracker.ts:199` (three `TrackEvent` fields) and `src/core/tracker.ts:367-369` (write them)
- Modify: `src/core/proxy.ts:1652` (declare the promise), `src/core/proxy.ts:1866-1873` (fire it), `src/core/proxy.ts:1555-1561` (await it in `finalize`)
- Test: `tests/thinking-probe.test.ts`

**Interfaces:**
- Consumes: `buildSentCountTokensBody`, `estimateImageTokens`, `SentProbeResult` from Task 1; `countTokensUpstream(url, body, headers): Promise<number | null>` (proxy.ts:1263).
- Produces: `TransformInfo.sentCountTokens?: number`, `sentImageTokensEst?: number`, `sentProbeStatus?: 'ok' | 'failed' | 'skipped'`; `TrackEvent.sent_count_tokens?`, `sent_image_tokens_est?`, `sent_probe_status?` (same types).

- [ ] **Step 1: Write the failing tests**

Create `tests/thinking-probe.test.ts`:

```ts
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
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }) +
    ev('message_stop', { type: 'message_stop' }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
};

async function drive(
  reqBody: string,
  countTokens: (probeBody: string) => Promise<Response> | Response,
  reply: () => Response = jsonReply,
  settleMs = 60,
) {
  const probes: string[] = [];
  const forwarded: string[] = [];
  const restore = mockUpstream(async (req) => {
    const url = new URL(req.url);
    if (url.pathname === '/v1/messages/count_tokens') {
      const b = await req.text();
      probes.push(b);
      return countTokens(b);
    }
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd $W && env PATH=/opt/node-24/bin:$PATH corepack pnpm vitest run tests/thinking-probe.test.ts; echo "rc=$?"`
Expected: FAIL. The first test fails on `expect(d.probes).toHaveLength(3)` (received 2), the tracker test on `sent_count_tokens` undefined. rc≠0.

- [ ] **Step 3: Add the `TransformInfo` fields** (`src/core/transform.ts`, directly after `baselineProbeStatus?: 'ok' | 'partial' | 'failed';`)

```ts
  /** count_tokens of the SENT body with pxpipe's own images removed (third probe,
   *  compressed Anthropic requests only). See src/core/sent-probe.ts. */
  sentCountTokens?: number;
  /** Computed cost of the pxpipe images removed for that probe (28-px patches). */
  sentImageTokensEst?: number;
  /** 'ok': third probe resolved. 'failed': it was due but did not resolve.
   *  'skipped': uncompressed, the sent body is the original and baselineTokens counts it. */
  sentProbeStatus?: 'ok' | 'failed' | 'skipped';
```

- [ ] **Step 4: Add the `TrackEvent` fields and write them** (`src/core/tracker.ts`)

After `baseline_probe_status?: 'ok' | 'partial' | 'failed';` (line 199):

```ts
  /** count_tokens of the sent body without pxpipe images (third probe). */
  sent_count_tokens?: number;
  /** Computed cost of the removed pxpipe images. */
  sent_image_tokens_est?: number;
  /** Third-probe outcome; 'skipped' on uncompressed rows. */
  sent_probe_status?: 'ok' | 'failed' | 'skipped';
```

After the block that writes `out.baseline_probe_status` (line 367-369):

```ts
    if (info.sentCountTokens !== undefined) out.sent_count_tokens = info.sentCountTokens;
    if (info.sentImageTokensEst !== undefined) out.sent_image_tokens_est = info.sentImageTokensEst;
    if (info.sentProbeStatus !== undefined) out.sent_probe_status = info.sentProbeStatus;
```

- [ ] **Step 5: Fire and await the probe** (`src/core/proxy.ts`)

Add an import next to the other `./measurement.js` import (line 13):

```ts
import { buildSentCountTokensBody, estimateImageTokens, type SentProbeResult } from './sent-probe.js';
```

After `let baselineCacheablePromise: Promise<number | null> | undefined;` (line 1652):

```ts
    // Third probe (compressed only): count_tokens of the SENT body without pxpipe's
    // images. Billed - (this + image cost) = what the provider bills but count_tokens
    // does not see (thinking blocks of earlier replies on Opus 5.5 / Fable 5.1).
    let sentProbePromise: Promise<SentProbeResult | null> | undefined;
```

Inside `if (ctBody) { … }`, directly after the closing `}` of `if (ctCacheableBody) { … }` (line 1873):

```ts
            if (r.info.compressed) {
              const sentBytes = r.body;
              const sentHeaders = new Headers(ctHeaders);
              // One tick later: parsing the multi-MiB sent body must not delay the main forward.
              sentProbePromise = new Promise<void>((done) => setTimeout(done, 0)).then(async () => {
                const sent = buildSentCountTokensBody(bodyIn, sentBytes);
                if (!sent) return null;
                const n = await countTokensUpstream(ctUrl, sent.body, sentHeaders);
                if (n === null) return null;
                return { countTokens: n, imageTokensEst: estimateImageTokens(sent.model, sent.removedImageDims) };
              });
            }
```

In `finalize`, inside `if (info && baselineStatusApplies) { … }`, directly after the `if (baselineResolved === null) { … } else { info.baselineProbeStatus = 'ok'; }` chain (line 1561):

```ts
          if (!info.compressed) {
            info.sentProbeStatus = 'skipped';
          } else {
            let sent: SentProbeResult | null = null;
            if (sentProbePromise) {
              try {
                sent = await sentProbePromise;
              } catch {
                sent = null;
              }
            }
            if (sent) {
              info.sentCountTokens = sent.countTokens;
              info.sentImageTokensEst = sent.imageTokensEst;
              info.sentProbeStatus = 'ok';
            } else {
              info.sentProbeStatus = 'failed';
            }
          }
```

If `bodyIn` is not typed `Uint8Array` at line 1684, wrap it: `buildSentCountTokensBody(new Uint8Array(bodyIn), sentBytes)`; typecheck in Step 6 tells.

- [ ] **Step 6: Run the tests and the typecheck**

Run:
```bash
cd $W && env PATH=/opt/node-24/bin:$PATH corepack pnpm vitest run tests/thinking-probe.test.ts tests/proxy-usage.test.ts tests/gateway.test.ts tests/savings-math-e2e.test.ts tests/tracker.test.ts; echo "test rc=$?"
env PATH=/opt/node-24/bin:$PATH corepack pnpm typecheck; echo "typecheck rc=$?"
```
Expected: PASS, both rc=0. `proxy-usage.test.ts:2094` still sees exactly one probe (its body is not compressed).

- [ ] **Step 7: Commit**

```bash
cd $W && git add src/core/transform.ts src/core/tracker.ts src/core/proxy.ts tests/thinking-probe.test.ts && git commit -q -F - <<'EOF'; echo "rc=$?"
feat(proxy): third count_tokens probe on the sent body, three log fields

Compressed Anthropic requests now log sent_count_tokens,
sent_image_tokens_est and sent_probe_status. The probe runs one tick
after the transform, alongside the forward; the client never waits.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BTHhT9kQufnhcWf5kXS2ut
EOF
```

---

### Task 3: Surcharge math, dashboard totals, `/proxy-stats`, restart replay

**Files:**
- Create: `src/core/thinking-floor.ts`
- Modify: `src/dashboard.ts` (Totals interface ~229, `emptyTotals` ~311, `baselineWarmth` map type 515, `update()` ~676-830 and accumulation 890, `replay()` ~1124-1182, `serveStats()` ~1318-1395)
- Modify: `src/dashboard/types.ts` (StatsPayload, after `saved_pct_input_only`)
- Modify: `docs/CACHING_AND_SAVINGS.md` (append a section)
- Test: `tests/thinking-floor.test.ts`

**Interfaces:**
- Consumes: Task 2's `info.sentCountTokens / sentImageTokensEst / sentProbeStatus` and `TrackEvent.sent_*`.
- Produces (thinking-floor.ts):
  - `interface SurchargeRow { compressed?: boolean; baseline_tokens?: number; input_tokens?: number; cache_create_tokens?: number; cache_read_tokens?: number; sent_count_tokens?: number; sent_image_tokens_est?: number; sent_probe_status?: string }`
  - `billedInputTokens(r: SurchargeRow): number`
  - `sentProbeSurcharge(r: SurchargeRow): number`
  - `rawThinkingSurcharge(r: SurchargeRow): number` (used by Task 5)
  - `floorBaselineSizes(baseline: number, cacheable: number, s: number): { baseline: number; cacheable: number }`
- Produces (StatsPayload, all optional numbers): `baseline_input_weighted_thinking_min`, `saved_input_tokens_thinking_min`, `saved_pct_input_only_thinking_min`, `thinking_floor_measured_requests`, `thinking_floor_eligible_requests` (used by Task 4).

Hand-computed numbers used below (rates: create 1.25, read 0.10):
- Request 1, cold: billed 2,000 + 30,000 = 32,000; counted 25,000 + 6,000 = 31,000; S = 1,000. Actual = 2,000 + 30,000×1.25 = 39,500. Baseline = 90,000×1.25 + 10,000 = 122,500. Floor = 91,000×1.25 + 10,000 = 123,750.
- Request 2, warm, same session: billed 2,000 + 2,000 + 30,000 = 34,000; counted 26,000 + 6,000; S = 2,000. Actual = 2,000 + 2,500 + 3,000 = 7,500. Baseline: reused 90,000×0.1 + grown 4,000×1.25 + cold 10,000 = 24,000. Floor: prior 91,000 (S-inclusive) → 91,000×0.1 + 5,000×1.25 + 10,000 = 25,350. (With the wrong prior 90,000 it would be 26,500.)

- [ ] **Step 1: Write the failing tests**

Create `tests/thinking-floor.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  floorBaselineSizes,
  rawThinkingSurcharge,
  sentProbeSurcharge,
} from '../src/core/thinking-floor.js';
import { DashboardState } from '../src/dashboard.js';
import { setAllowedModelBases } from '../src/core/applicability.js';
import type { StatsPayload } from '../src/dashboard/types.js';

describe('surcharge', () => {
  const row = {
    compressed: true, input_tokens: 2000, cache_create_tokens: 30000, cache_read_tokens: 0,
    sent_count_tokens: 25000, sent_image_tokens_est: 6000, sent_probe_status: 'ok',
  };
  it('is billed minus sent count minus image cost', () => {
    expect(sentProbeSurcharge(row)).toBe(1000);
  });
  it('is floored at 0', () => {
    expect(sentProbeSurcharge({ ...row, sent_count_tokens: 40000 })).toBe(0);
  });
  it('is 0 when unmeasured, failed or uncompressed', () => {
    expect(sentProbeSurcharge({ ...row, sent_probe_status: 'failed' })).toBe(0);
    expect(sentProbeSurcharge({ ...row, sent_count_tokens: undefined })).toBe(0);
    expect(sentProbeSurcharge({ ...row, compressed: false })).toBe(0);
  });
  it('raw: uncompressed uses billed minus baseline, compressed uses the probe', () => {
    expect(rawThinkingSurcharge({ compressed: false, baseline_tokens: 1000, input_tokens: 1100 })).toBe(100);
    expect(rawThinkingSurcharge(row)).toBe(1000);
  });
  it('adds S to the cacheable part only when there is one', () => {
    expect(floorBaselineSizes(100000, 90000, 1000)).toEqual({ baseline: 101000, cacheable: 91000 });
    expect(floorBaselineSizes(100000, 0, 1000)).toEqual({ baseline: 101000, cacheable: 0 });
  });
});

// ---- dashboard -----------------------------------------------------------

const SID = 'thinkA01';
const SYS = 'sys00001';
function live(p: {
  inp: number; cc: number; cr: number; base: number; cacheable: number;
  sent?: number; img?: number; status?: 'ok' | 'failed'; probe?: 'ok' | 'failed';
}) {
  return {
    method: 'POST', path: '/v1/messages', model: 'claude-fable-5-1', status: 200, durationMs: 0,
    usage: { input_tokens: p.inp, output_tokens: 100, cache_creation_input_tokens: p.cc, cache_read_input_tokens: p.cr },
    info: {
      compressed: true, firstUserSha8: SID, systemSha8: SYS,
      baselineTokens: p.base, baselineCacheableTokens: p.cacheable, baselineProbeStatus: p.probe ?? 'ok',
      ...(p.status ? { sentCountTokens: p.sent, sentImageTokensEst: p.img, sentProbeStatus: p.status } : {}),
    },
  };
}
const R1 = { inp: 2000, cc: 30000, cr: 0, base: 100000, cacheable: 90000, sent: 25000, img: 6000, status: 'ok' as const };
const R2 = { inp: 2000, cc: 2000, cr: 30000, base: 104000, cacheable: 94000, sent: 26000, img: 6000, status: 'ok' as const };
const stats = async (d: DashboardState) => (await d.serveStats().json()) as StatsPayload;

describe('dashboard thinking floor', () => {
  beforeEach(() => setAllowedModelBases(['claude-fable-5']));
  afterEach(() => setAllowedModelBases(null));

  it('cold first request: floor adds S to both baseline sizes', async () => {
    const d = new DashboardState();
    d.update(live(R1) as never);
    const s = await stats(d);
    expect(s.baseline_input_weighted).toBe(122500);
    expect(s.actual_input_weighted).toBe(39500);
    expect(s.baseline_input_weighted_thinking_min).toBe(123750);
    expect(s.saved_input_tokens_thinking_min).toBe(84250);
    expect(s.saved_pct_input_only_thinking_min).toBe(68.1);
    expect(s.thinking_floor_measured_requests).toBe(1);
    expect(s.thinking_floor_eligible_requests).toBe(1);
  });

  it('warm follow-up: uses the S-inclusive prior for the reused/grown split', async () => {
    const d = new DashboardState();
    d.update(live(R1) as never);
    d.update(live(R2) as never);
    const s = await stats(d);
    expect(s.baseline_input_weighted).toBe(146500);
    expect(s.actual_input_weighted).toBe(47000);
    expect(s.baseline_input_weighted_thinking_min).toBe(149100);
  });

  it('existing payload keys do not change when the sent fields are present', async () => {
    const a = new DashboardState();
    a.update(live(R1) as never);
    a.update(live(R2) as never);
    const b = new DashboardState();
    b.update(live({ ...R1, status: undefined }) as never);
    b.update(live({ ...R2, status: undefined }) as never);
    const [sa, sb] = [await stats(a), await stats(b)];
    for (const k of [
      'requests', 'compressed_requests', 'baseline_input_weighted', 'actual_input_weighted',
      'saved_input_tokens', 'saved_pct', 'saved_pct_input_only', 'saved_pct_of_total_bill',
      'saved_pct_of_all_spend', 'all_baseline_equivalent_weighted', 'all_actual_input_weighted',
    ] as const) {
      expect(sa[k]).toEqual(sb[k]);
    }
  });

  it('missing sent fields: floor equals the headline baseline, counted as unmeasured', async () => {
    const d = new DashboardState();
    d.update(live({ ...R1, status: undefined }) as never);
    const s = await stats(d);
    expect(s.baseline_input_weighted_thinking_min).toBe(s.baseline_input_weighted);
    expect(s.thinking_floor_measured_requests).toBe(0);
    expect(s.thinking_floor_eligible_requests).toBe(1);
  });

  it('row without a usable baseline stays out of the floor totals even when the third probe resolved', async () => {
    const d = new DashboardState();
    d.update(live({ ...R1, probe: 'failed' }) as never);
    const s = await stats(d);
    expect(s.baseline_input_weighted).toBe(0);
    expect(s.baseline_input_weighted_thinking_min).toBe(0);
    expect(s.thinking_floor_eligible_requests).toBe(0);
    expect(s.thinking_floor_measured_requests).toBe(0);
  });

  it('restart: replay restores the S-inclusive prior from the log', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-floor-'));
    const file = path.join(dir, 'events.jsonl');
    const t1 = {
      ts: new Date(Date.now() - 5000).toISOString(), method: 'POST', path: '/v1/messages',
      model: 'claude-fable-5-1', status: 200, duration_ms: 1000, compressed: true,
      input_tokens: 2000, output_tokens: 100, cache_create_tokens: 30000, cache_read_tokens: 0,
      first_user_sha8: SID, system_sha8: SYS, baseline_tokens: 100000,
      baseline_cacheable_tokens: 90000, baseline_probe_status: 'ok',
      sent_count_tokens: 25000, sent_image_tokens_est: 6000, sent_probe_status: 'ok',
    };
    fs.writeFileSync(file, JSON.stringify(t1) + '\n');
    try {
      const d = new DashboardState();
      await d.replay(file);
      d.update(live(R2) as never);
      const s = await stats(d);
      expect(s.baseline_input_weighted).toBe(24000);
      expect(s.baseline_input_weighted_thinking_min).toBe(25350);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd $W && env PATH=/opt/node-24/bin:$PATH corepack pnpm vitest run tests/thinking-floor.test.ts; echo "rc=$?"`
Expected: FAIL, "Failed to resolve import ../src/core/thinking-floor.js", rc≠0.

- [ ] **Step 3: Create `src/core/thinking-floor.ts`**

```ts
/**
 * Thinking-aware baseline floor.
 * Design: docs/superpowers/specs/2026-10-07-thinking-baseline-floor-design.md
 *
 * count_tokens does not count the thinking blocks of earlier replies, but
 * claude-opus-5-5 / claude-fable-5-1 are billed for them, so baseline_tokens is
 * too low. On compressed rows the third probe measures the gap on the SENT body:
 * S = billed input - (sent_count_tokens + sent_image_tokens_est), floored at 0.
 * Unmeasured rows get S = 0, which keeps the corrected baseline a lower bound
 * (thinking pxpipe collapsed away is not in the sent body and is not recovered).
 */
export interface SurchargeRow {
  compressed?: boolean;
  baseline_tokens?: number;
  input_tokens?: number;
  cache_create_tokens?: number;
  cache_read_tokens?: number;
  sent_count_tokens?: number;
  sent_image_tokens_est?: number;
  sent_probe_status?: string;
}

export function billedInputTokens(r: SurchargeRow): number {
  return (r.input_tokens ?? 0) + (r.cache_create_tokens ?? 0) + (r.cache_read_tokens ?? 0);
}

/** Compressed rows: billed tokens the sent-body probe could not account for. */
export function sentProbeSurcharge(r: SurchargeRow): number {
  if (r.compressed !== true || r.sent_probe_status !== 'ok') return 0;
  if (typeof r.sent_count_tokens !== 'number' || !(r.sent_count_tokens > 0)) return 0;
  const counted = r.sent_count_tokens + Math.max(0, r.sent_image_tokens_est ?? 0);
  return Math.max(0, billedInputTokens(r) - counted);
}

/** Long-run stats (raw tokens): uncompressed rows forward the original, so
 *  billed - baseline_tokens IS the gap (exact, floored at 0). Compressed rows
 *  use the sent-body probe. */
export function rawThinkingSurcharge(r: SurchargeRow): number {
  if (r.compressed === true) return sentProbeSurcharge(r);
  const base = r.baseline_tokens;
  if (typeof base !== 'number' || !(base > 0)) return 0;
  return Math.max(0, billedInputTokens(r) - base);
}

/** Baseline sizes with S added. The thinking blocks sit in earlier replies,
 *  i.e. before the last cache marker, so S joins the cacheable part too when
 *  there is one (no marker: nothing cacheable, unchanged). */
export function floorBaselineSizes(
  baseline: number,
  cacheable: number,
  s: number,
): { baseline: number; cacheable: number } {
  return { baseline: baseline + s, cacheable: cacheable > 0 ? cacheable + s : 0 };
}
```

- [ ] **Step 4: Wire the dashboard** (`src/dashboard.ts`)

4a. Import (next to the existing `./core/baseline.js` import):

```ts
import { floorBaselineSizes, sentProbeSurcharge, type SurchargeRow } from './core/thinking-floor.js';
```

4b. `interface Totals`, after `baselineInputWeighted: number;`:

```ts
  /** Same rows as `baselineInputWeighted`, with the thinking surcharge added to
   *  the baseline sizes. Lower bound; see src/core/thinking-floor.ts. Non-Anthropic
   *  rows contribute their unchanged baseline so the sum stays paired with actual. */
  baselineInputWeightedThinkingFloor: number;
  /** Anthropic rows in the token headline (creditSaving). */
  thinkingFloorEligible: number;
  /** ...of which the third probe resolved. */
  thinkingFloorMeasured: number;
```

`emptyTotals()`, after `baselineInputWeighted: 0,`:

```ts
    baselineInputWeightedThinkingFloor: 0,
    thinkingFloorEligible: 0,
    thinkingFloorMeasured: 0,
```

4c. Map type at line 515:

```ts
  private baselineWarmth: Map<string, { ts: number; cacheable: number; cacheableFloor?: number; prefixSha?: string }> = new Map();
```

4d. `update()` only. After `let baselineInputEff: number;` in `update()` (first occurrence, ~line 680):

```ts
    let floorBaselineEff: number; // thinking-aware floor; equals baselineInputEff off the Anthropic path
    let floorEligible = false;
    let floorMeasured = false;
```

In `update()`, after each of the two lines `baselineInputEff = e.baselineInputEff;` (Google branch and GPT branch):

```ts
        floorBaselineEff = baselineInputEff;
```

In `update()`'s Anthropic branch, directly after the `baselineInputEff = creditSaving ? computeBaselineInputEffWithCacheTier(…) : actualInputEff;` statement (~line 810) and before `// Record this completed turn's prefix size…`:

```ts
      // Thinking-aware floor: same formula, sizes + S, own S-inclusive prior.
      const surcharge = sentProbeSurcharge({
        compressed,
        input_tokens: inp,
        cache_create_tokens: cc,
        cache_read_tokens: cr,
        sent_count_tokens: info?.sentCountTokens,
        sent_image_tokens_est: info?.sentImageTokensEst,
        sent_probe_status: info?.sentProbeStatus,
      });
      const floorSizes = floorBaselineSizes(baseline ?? 0, cacheable, surcharge);
      const floorWarmth = deriveBaselineWarmth(
        warmthPrev ? { ...warmthPrev, cacheable: warmthPrev.cacheableFloor ?? warmthPrev.cacheable } : undefined,
        requestStartSec,
        floorSizes.cacheable,
        cr,
        DashboardState.CACHE_TTL_SEC,
        prefixShaNow,
      );
      floorBaselineEff = creditSaving
        ? computeBaselineInputEffWithCacheTier(
            floorSizes.baseline,
            floorSizes.cacheable,
            inp,
            cc,
            cr,
            floorWarmth.warm,
            floorWarmth.prevCacheable,
            cc1h,
            cc5m,
          )
        : actualInputEff;
      floorEligible = creditSaving;
      floorMeasured = creditSaving && info?.sentProbeStatus === 'ok';
```

In the same branch, the `this.baselineWarmth.set(sidNow, { … })` object gets one more property after `cacheable: …,`:

```ts
          cacheableFloor:
            floorSizes.cacheable > 0
              ? floorSizes.cacheable
              : (warmthPrev?.cacheableFloor ?? warmthPrev?.cacheable ?? 0),
```

Accumulation, directly after `totals.baselineInputWeighted += baselineInputEff;` (line 890):

```ts
      totals.baselineInputWeightedThinkingFloor += floorBaselineEff;
      if (floorEligible) totals.thinkingFloorEligible += 1;
      if (floorMeasured) totals.thinkingFloorMeasured += 1;
```

4e. `replay()` (restart): in the Anthropic `else` branch, before `this.baselineWarmth.set(sidR, { … })` (~line 1170):

```ts
        const floorCacheableR = floorBaselineSizes(
          baseline ?? 0,
          cacheable,
          sentProbeSurcharge(t as SurchargeRow),
        ).cacheable;
```

and in that `set(sidR, { … })` object, after `cacheable: …,`:

```ts
            cacheableFloor:
              floorCacheableR > 0
                ? floorCacheableR
                : (warmthPrevR?.cacheableFloor ?? warmthPrevR?.cacheable ?? 0),
```

4f. `serveStats()`: after `const pctInput = baseline > 0 ? (saved / baseline) * 100 : 0;`:

```ts
    const floorBaseline = totals.baselineInputWeightedThinkingFloor;
    const pctInputThinkingMin = floorBaseline > 0 ? ((floorBaseline - actual) / floorBaseline) * 100 : 0;
```

and in `payload`, after `saved_pct_input_only: round1(pctInput),`:

```ts
      // Lower bound with the thinking tokens count_tokens skips (src/core/thinking-floor.ts).
      baseline_input_weighted_thinking_min: Math.round(floorBaseline),
      saved_input_tokens_thinking_min: Math.round(floorBaseline - actual),
      saved_pct_input_only_thinking_min: round1(pctInputThinkingMin),
      thinking_floor_measured_requests: totals.thinkingFloorMeasured,
      thinking_floor_eligible_requests: totals.thinkingFloorEligible,
```

4g. `src/dashboard/types.ts`, in `StatsPayload` after `saved_pct_input_only: number;`:

```ts
  /** Lower bound incl. billed thinking that count_tokens skips (third probe). */
  baseline_input_weighted_thinking_min?: number;
  saved_input_tokens_thinking_min?: number;
  saved_pct_input_only_thinking_min?: number;
  thinking_floor_measured_requests?: number;
  thinking_floor_eligible_requests?: number;
```

- [ ] **Step 5: Document the fields** — append to `docs/CACHING_AND_SAVINGS.md`:

```markdown

## Thinking-aware floor (lower bound)

`/v1/messages/count_tokens` does not count the thinking blocks of earlier
assistant replies, but `claude-opus-5-5` and `claude-fable-5-1` are billed for
them as input. `baseline_tokens` is therefore too low for those models, and the
headline saving with it. The headline stays as it is; a second, corrected
number is shown next to it.

On compressed requests pxpipe runs a third `count_tokens` probe on the body it
actually sends, with its own rendered images removed (client images stay), and
prices the removed images with the 28-px patch formula:

- `sent_count_tokens`: count of that body
- `sent_image_tokens_est`: cost of the removed pxpipe images
- `sent_probe_status`: `ok` / `failed` / `skipped` (uncompressed: the sent body is the original)

Per row `S = max(0, input + cache_create + cache_read - sent_count_tokens - sent_image_tokens_est)`,
and `S = 0` when the probe did not resolve. S is added to `baseline_tokens` and,
when there is a cache marker, to `baseline_cacheable_tokens`; the cache-aware
formula above then runs unchanged. The per-session prior for the reused/grown
split keeps its own S-inclusive cacheable size. Thinking that pxpipe collapsed
away is not in the sent body and is not recovered, so the result is a lower bound.

`/proxy-stats` adds `baseline_input_weighted_thinking_min`,
`saved_input_tokens_thinking_min`, `saved_pct_input_only_thinking_min`,
`thinking_floor_measured_requests` and `thinking_floor_eligible_requests`. The
long-run stats (`pxpipe stats`, `/api/stats.json`) add the same correction on raw
tokens; there uncompressed rows use `S = max(0, billed - baseline_tokens)`.
```

- [ ] **Step 6: Run the tests and the typecheck**

Run:
```bash
cd $W && env PATH=/opt/node-24/bin:$PATH corepack pnpm vitest run tests/thinking-floor.test.ts tests/dashboard-api.test.ts tests/restart-restore.test.ts tests/savings-honesty.test.ts tests/sessions.test.ts tests/docs-integrity.test.ts; echo "test rc=$?"
env PATH=/opt/node-24/bin:$PATH corepack pnpm typecheck; echo "typecheck rc=$?"
```
Expected: PASS, both rc=0.

- [ ] **Step 7: Commit**

```bash
cd $W && git add src/core/thinking-floor.ts src/dashboard.ts src/dashboard/types.ts docs/CACHING_AND_SAVINGS.md tests/thinking-floor.test.ts && git commit -q -F - <<'EOF'; echo "rc=$?"
feat(dashboard): thinking-aware baseline floor next to the headline

S from the third probe is added to both baseline sizes and the existing
cache-aware formula runs unchanged; the per-session prior keeps its own
S-inclusive size, also across replay after a restart. Existing payload
keys are unchanged; five new keys on /proxy-stats.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BTHhT9kQufnhcWf5kXS2ut
EOF
```

---

### Task 4: Hero line and "Show the math" row

**Files:**
- Modify: `src/dashboard/fragments.ts` (`renderSessionSummaryFragment` ~192-240, `savedMath` ~335-342)
- Test: `tests/hero.test.ts` (extend)

**Interfaces:**
- Consumes: the five optional `StatsPayload` keys from Task 3.
- Produces: HTML only.

- [ ] **Step 1: Write the failing tests** — append to `tests/hero.test.ts` (it already has `payload()`):

```ts
import { renderHeaderFragment } from '../src/dashboard/fragments.js';

describe('thinking floor line', () => {
  const floor = {
    baseline_input_weighted: 7000, actual_input_weighted: 1800,
    baseline_input_weighted_thinking_min: 7400, saved_pct_input_only_thinking_min: 75.7,
    thinking_floor_measured_requests: 1412, thinking_floor_eligible_requests: 1430,
  };
  it('shows the lower bound under the unchanged headline', () => {
    const html = renderSessionSummaryFragment(payload(floor));
    expect(html).toContain('74%'); // headline unchanged: 1 - 1800/7000
    expect(html).toContain("Counting earlier replies' thinking: at least 76% fewer · 1,412 of 1,430 imaged requests measured");
  });
  it('words a negative lower bound as "at most … more"', () => {
    const html = renderSessionSummaryFragment(payload({ ...floor, saved_pct_input_only_thinking_min: -3.2 }));
    expect(html).toContain('at most 3% more');
  });
  it('shows nothing when no request was eligible (older server, non-Anthropic)', () => {
    const html = renderSessionSummaryFragment(payload({ baseline_input_weighted: 7000, actual_input_weighted: 1800 }));
    expect(html).not.toContain('Counting earlier replies');
  });
  it('adds a lower-bound row to "Show the math"', () => {
    const html = renderHeaderFragment(payload(floor), 47821);
    expect(html).toContain('baseline incl. thinking');
    expect(html).toContain('lower bound');
  });
});
```

If `renderHeaderFragment` needs more payload keys than `payload()` provides and throws, extend the `floor` object with the missing keys (with `0` or `{}` values) and note them in the task report.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd $W && env PATH=/opt/node-24/bin:$PATH corepack pnpm vitest run tests/hero.test.ts; echo "rc=$?"`
Expected: the four new tests FAIL (strings not found), the four old ones PASS. rc≠0.

- [ ] **Step 3: Implement** (`src/dashboard/fragments.ts`)

Add above `renderSessionSummaryFragment`:

```ts
/** Lower-bound saving once the thinking tokens count_tokens skips are added
 *  back (third probe). Empty when no request was eligible. */
function thinkingFloorLine(s: StatsPayload): string {
  const eligible = s.thinking_floor_eligible_requests ?? 0;
  if (eligible <= 0) return '';
  const measured = s.thinking_floor_measured_requests ?? 0;
  const pct = s.saved_pct_input_only_thinking_min ?? 0;
  const claim = pct >= 0
    ? `at least ${Math.abs(pct).toFixed(0)}% fewer`
    : `at most ${Math.abs(pct).toFixed(0)}% more`;
  return (
    `<div class="hero-meta">Counting earlier replies' thinking: ${claim} · ` +
    `${numFmt(measured)} of ${numFmt(eligible)} imaged requests measured</div>`
  );
}
```

In `renderSessionSummaryFragment`'s return, insert `thinkingFloorLine(s) +` directly before the line `` `<div class="hero-meta">` + `` (the existing provider-token meta line).

In `savedMath`, directly after the `mathRow('saved', s.saved_input_tokens, …) +` line:

```ts
    ((s.thinking_floor_eligible_requests ?? 0) > 0
      ? mathRow(
          'baseline incl. thinking',
          s.baseline_input_weighted_thinking_min,
          `(lower bound: adds billed thinking that count_tokens skips, measured on ${numFmt(s.thinking_floor_measured_requests ?? 0)} of ${numFmt(s.thinking_floor_eligible_requests ?? 0)} requests)`,
        )
      : '') +
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd $W && env PATH=/opt/node-24/bin:$PATH corepack pnpm vitest run tests/hero.test.ts tests/dashboard-api.test.ts tests/models-fragment-escape.test.ts; echo "rc=$?"`
Expected: PASS, rc=0.

- [ ] **Step 5: Commit**

```bash
cd $W && git add src/dashboard/fragments.ts tests/hero.test.ts && git commit -q -F - <<'EOF'; echo "rc=$?"
feat(dashboard): show the thinking-aware lower bound under the headline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BTHhT9kQufnhcWf5kXS2ut
EOF
```

---

### Task 5: Long-run stats (`src/stats.ts`, `/api/stats.json`)

**Files:**
- Modify: `src/stats.ts` (Summary ~44-51, `newSummary` ~80-83, `fold` ~147-153, `renderTextReport` ~264, `summaryToJson` ~386)
- Test: `tests/stats.test.ts` (extend)

**Interfaces:**
- Consumes: `rawThinkingSurcharge` from Task 3; `TrackEvent.sent_*` from Task 2.
- Produces: `Summary.baselineThinkingFloorTotal: number`, `Summary.thinkingFloorMeasuredEvents: number`; JSON keys `baselineThinkingFloorTotal`, `savedTokensThinkingFloorTotal`, `thinkingFloorMeasuredEvents`.

- [ ] **Step 1: Write the failing tests** — add `summaryToJson` to the existing import on line 5 of `tests/stats.test.ts` (`import { newSummary, fold, renderTextReport, runStats, summaryToJson } from '../src/stats.js';`), then append:

```ts
describe('thinking floor (raw tokens)', () => {
  const rows = [
    // uncompressed: billed 1100 vs baseline 1000 → S = 100 (exact)
    ev({ compressed: false, baseline_tokens: 1000, baseline_probe_status: 'ok', input_tokens: 1100 }),
    // compressed, probe ok: 32000 - (25000 + 6000) → S = 1000
    ev({ compressed: true, baseline_tokens: 50000, baseline_probe_status: 'ok', input_tokens: 2000,
         cache_create_tokens: 30000, sent_count_tokens: 25000, sent_image_tokens_est: 6000, sent_probe_status: 'ok' }),
    // compressed, older row without the fields → S = 0
    ev({ compressed: true, baseline_tokens: 40000, baseline_probe_status: 'ok', input_tokens: 10000 }),
  ];
  it('adds S per row on top of the measured baseline', () => {
    const s = newSummary();
    for (const r of rows) fold(s, r);
    expect(s.baselineTokensTotal).toBe(91000);
    expect(s.baselineThinkingFloorTotal).toBe(92100);
    expect(s.measuredActualTokensTotal).toBe(43100);
    expect(s.thinkingFloorMeasuredEvents).toBe(1);
    const j = summaryToJson(s);
    expect(j.baselineThinkingFloorTotal).toBe(92100);
    expect(j.savedTokensThinkingFloorTotal).toBe(49000);
    expect(j.thinkingFloorMeasuredEvents).toBe(1);
    expect(renderTextReport(s)).toContain('saved incl. thinking');
  });
  it('never subtracts: an uncompressed row billed below its baseline adds 0', () => {
    const s = newSummary();
    fold(s, ev({ compressed: false, baseline_tokens: 1000, baseline_probe_status: 'ok', input_tokens: 990 }));
    expect(s.baselineThinkingFloorTotal).toBe(1000);
  });
  it('rows without a usable probe stay out, as for the existing totals', () => {
    const s = newSummary();
    fold(s, ev({ compressed: false, baseline_tokens: 1000, baseline_probe_status: 'failed', input_tokens: 1100 }));
    expect(s.baselineThinkingFloorTotal).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd $W && env PATH=/opt/node-24/bin:$PATH corepack pnpm vitest run tests/stats.test.ts; echo "rc=$?"`
Expected: the new tests FAIL (`baselineThinkingFloorTotal` undefined), rc≠0.

- [ ] **Step 3: Implement** (`src/stats.ts`)

Import at the top:

```ts
import { rawThinkingSurcharge } from './core/thinking-floor.js';
```

`Summary`, after `baselineMeasuredEvents: number;`:

```ts
  /** Same probe-OK rows as baselineTokensTotal with the thinking surcharge added
   *  (raw tokens, lower bound; src/core/thinking-floor.ts rawThinkingSurcharge). */
  baselineThinkingFloorTotal: number;
  /** Compressed probe-OK rows whose third (sent-body) probe resolved. */
  thinkingFloorMeasuredEvents: number;
```

`newSummary()`, after `baselineMeasuredEvents: 0,`:

```ts
    baselineThinkingFloorTotal: 0,
    thinkingFloorMeasuredEvents: 0,
```

`fold()`, inside `if (typeof baseline === 'number' && baseline > 0 && probeOk) { … }` after `s.baselineMeasuredEvents++;`:

```ts
    s.baselineThinkingFloorTotal += baseline + rawThinkingSurcharge(ev);
    if (ev.compressed === true && ev.sent_probe_status === 'ok') s.thinkingFloorMeasuredEvents++;
```

`renderTextReport`, directly after the `saved:` line push:

```ts
  const savedFloor = s.baselineThinkingFloorTotal - s.measuredActualTokensTotal;
  lines.push(
    `  saved incl. thinking: ${fmtN(savedFloor).padStart(10)}  (${fmtPct(savedFloor, s.baselineThinkingFloorTotal)}, lower bound; third probe on ${fmtN(s.thinkingFloorMeasuredEvents)} compressed requests)`,
  );
```

`summaryToJson`, after `savedTokensTotal: …,`:

```ts
    baselineThinkingFloorTotal: s.baselineThinkingFloorTotal,
    savedTokensThinkingFloorTotal: s.baselineThinkingFloorTotal - s.measuredActualTokensTotal,
    thinkingFloorMeasuredEvents: s.thinkingFloorMeasuredEvents,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd $W && env PATH=/opt/node-24/bin:$PATH corepack pnpm vitest run tests/stats.test.ts tests/dashboard-api.test.ts; echo "rc=$?"`
Expected: PASS, rc=0.

- [ ] **Step 5: Commit**

```bash
cd $W && git add src/stats.ts tests/stats.test.ts && git commit -q -F - <<'EOF'; echo "rc=$?"
feat(stats): thinking-aware lower bound in the long-run stats

Uncompressed rows add billed - baseline (exact, floored at 0); compressed
rows use the third probe. Readable across restarts without waiting.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BTHhT9kQufnhcWf5kXS2ut
EOF
```

---

### Task 6: Mutation check and full verification

**Files:** none changed (mutations are reverted).

- [ ] **Step 1: Each mutation must turn a test red**

```bash
cd $W && cat > /tmp/claude-0/mut.py <<'EOF'
import os, subprocess, sys
W = '/srv/pxpipe-worktrees/thinking-baseline-floor'
ENV = dict(os.environ, PATH='/opt/node-24/bin:' + os.environ.get('PATH', ''))
M = [
  ('M1 S not on cacheable', 'src/core/thinking-floor.ts',
   'cacheable: cacheable > 0 ? cacheable + s : 0', 'cacheable: cacheable', 'tests/thinking-floor.test.ts'),
  ('M2 no floor at 0', 'src/core/thinking-floor.ts',
   'return Math.max(0, billedInputTokens(r) - counted);', 'return billedInputTokens(r) - counted;', 'tests/thinking-floor.test.ts'),
  ('M3 wrong session prior', 'src/dashboard.ts',
   'cacheable: warmthPrev.cacheableFloor ?? warmthPrev.cacheable', 'cacheable: warmthPrev.cacheable', 'tests/thinking-floor.test.ts'),
  ('M4 pxpipe images not removed', 'src/core/sent-probe.ts',
   'if (data !== null && !client.has(data)) {', 'if (data !== null && false) {', 'tests/sent-probe.test.ts tests/thinking-probe.test.ts'),
]
bad = 0
for name, f, old, new, tests in M:
    p = f'{W}/{f}'; src = open(p).read()
    assert src.count(old) == 1, (name, src.count(old))
    open(p, 'w').write(src.replace(old, new))
    try:
        rc = subprocess.run(['/opt/node-24/bin/corepack', 'pnpm', 'vitest', 'run', *tests.split()],
                            cwd=W, env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode
    finally:
        open(p, 'w').write(src)
    print(f'{name}: rc={rc} -> {"RED (good)" if rc != 0 else "GREEN (BAD: no test catches it)"}')
    bad += rc == 0
print('mutations survived:', bad); sys.exit(1 if bad else 0)
EOF
python3 /tmp/claude-0/mut.py; echo "rc=$?"; git status --short
```

Expected: four lines "RED (good)", "mutations survived: 0", rc=0, `git status --short` empty (all files restored).

- [ ] **Step 2: Full suite, typecheck, build — each exit code on its own**

```bash
cd $W && env PATH=/opt/node-24/bin:$PATH corepack pnpm vitest run > /tmp/claude-0/vitest-full.txt 2>&1; echo "test rc=$?"; tail -5 /tmp/claude-0/vitest-full.txt
env PATH=/opt/node-24/bin:$PATH corepack pnpm typecheck; echo "typecheck rc=$?"
env PATH=/opt/node-24/bin:$PATH corepack pnpm build > /tmp/claude-0/build.txt 2>&1; echo "build rc=$?"
sha256sum dist/node.js | cut -c1-16
```

Expected: rc=0 three times. Test count = the Task 1 Step 1 count + 32 (sent-probe 9, thinking-probe 5, thinking-floor 11, hero 4, stats 3), test files + 3, no failures, no newly skipped tests. Write down the 16-char sha of `dist/node.js` (the trial and rollout use it).

No commit (nothing changed).

---

### Task 7: Side-port trial (old vs new, stub upstream)

**Files (outside the repo):** `T=/srv/pxpipe-rollback/trial-thinking-floor-<YYYY-MM-DD>` with `run.sh`, `stub.py`, `client.py`, `ana.py`, logs. Results also appended to the spec in the repo.

- [ ] **Step 1: Set up the trial folder**

```bash
T=/srv/pxpipe-rollback/trial-thinking-floor-$(date -u +%F); S=/srv/pxpipe-rollback/trial-ops5-2026-10-03
mkdir -p $T && cd $T
sed "s#T=/srv/pxpipe-rollback/trial-ops5-2026-10-03#T=$T#" $S/run.sh > run.sh && chmod +x run.sh
grep -c "T=$T" run.sh   # expect 1
cp $S/client.py client.py
python3 - <<'EOF'
p = 'client.py'; s = open(p).read()
old = "{'role': 'assistant', 'content': [{'type': 'text', 'text': f'reading file {i}'}"
new = "{'role': 'assistant', 'content': [{'type': 'thinking', 'thinking': prose(5000 + i, 800), 'signature': f'sig{i}'}, {'type': 'text', 'text': f'reading file {i}'}"
assert s.count(old) == 1; open(p, 'w').write(s.replace(old, new)); print('client ok')
EOF
```

Expected: `1`, `client ok`.

- [ ] **Step 2: Write `stub.py`** (behaves like the provider: count_tokens ignores thinking blocks, billing charges K per thinking block)

```python
import json, sys, base64, math, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
OUT = sys.argv[2]; lock = threading.Lock()
K = 500  # billed per thinking block, invisible to count_tokens

def png_dims(b64):
    try: raw = base64.b64decode(b64[:32])
    except Exception: return None
    if raw[:8] != b'\x89PNG\r\n\x1a\n' or raw[12:16] != b'IHDR': return None
    return int.from_bytes(raw[16:20], 'big'), int.from_bytes(raw[20:24], 'big')

def tally(j):
    t = {'chars': 0, 'img': 0, 'think': 0}
    def walk(v):
        if isinstance(v, str): t['chars'] += len(v); return
        if isinstance(v, list):
            for x in v: walk(x)
            return
        if not isinstance(v, dict): return
        ty = v.get('type')
        if ty == 'thinking': t['think'] += 1
        elif ty == 'image':
            d = png_dims((v.get('source') or {}).get('data', ''))
            if d: t['img'] += math.ceil(d[0] / 28) * math.ceil(d[1] / 28)  # pages fit the high-res tier, no downscale
        elif ty == 'text': t['chars'] += len(v.get('text', ''))
        elif ty == 'tool_use': t['chars'] += len(json.dumps(v.get('input', {})))
        elif ty == 'tool_result': walk(v.get('content'))
    walk(j.get('system'))
    for m in j.get('messages') or []: walk(m.get('content'))
    return t

class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *a): pass
    def _body(self):
        if self.headers.get('Transfer-Encoding', '').lower() == 'chunked':
            buf = b''
            while True:
                n = int(self.rfile.readline().strip().split(b';')[0], 16)
                if n == 0: self.rfile.readline(); break
                buf += self.rfile.read(n); self.rfile.readline()
            return buf
        return self.rfile.read(int(self.headers.get('Content-Length', '0')))
    def _send(self, obj):
        b = json.dumps(obj).encode(); self.send_response(200); self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self): self._send({'ok': True})
    def do_POST(self):
        body = self._body(); rec = {'path': self.path, 'bytes': len(body), 'slab': b'SLAB' in body}
        try:
            j = json.loads(body); t = tally(j); rec.update(model=j.get('model'), **t)
        except Exception as e:
            rec['err'] = str(e)[:80]; t = {'chars': 0, 'img': 0, 'think': 0}
        text_tok = t['chars'] // 4
        if self.path.startswith('/v1/messages/count_tokens'):
            rec['answer'] = max(1, text_tok + t['img'])
            with lock: open(OUT, 'a').write(json.dumps(rec) + '\n')
            self._send({'input_tokens': rec['answer']})
        else:
            rec['billed'] = text_tok + t['img'] + K * t['think']
            with lock: open(OUT, 'a').write(json.dumps(rec) + '\n')
            self._send({'id': 'msg_trial', 'type': 'message', 'role': 'assistant', 'model': rec.get('model') or 'x',
                        'content': [{'type': 'text', 'text': 'ok'}], 'stop_reason': 'end_turn', 'stop_sequence': None,
                        'usage': {'input_tokens': rec['billed'], 'output_tokens': 1,
                                  'cache_creation_input_tokens': 0, 'cache_read_input_tokens': 0}})

ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
```

- [ ] **Step 3: Write `ana.py`**

```python
import json, sys, statistics as st
T = sys.argv[1]; RUNS = sys.argv[2:]; K = 500
SEQ = [('oLONG', r) for r in (600, 601, 602, 650)] + [('oMID', r) for r in (150, 151, 300, 301)] + [('fLONG', r) for r in (600, 601, 650)]
def load(p): return [json.loads(l) for l in open(p) if l.strip()]
R = {}; verdict = []
for n in RUNS:
    ev = [e for e in load(f'{T}/ev-{n}.jsonl') if e.get('path') == '/v1/messages']
    up = load(f'{T}/up-{n}.jsonl')
    main = [u for u in up if u.get('path') == '/v1/messages']
    ct = [u for u in up if str(u.get('path', '')).startswith('/v1/messages/count_tokens')]
    if not (len(ev) == len(main) == len(SEQ)): sys.exit(f'{n}: {len(ev)} events, {len(main)} upstream, want {len(SEQ)}')
    third = [u['bytes'] for u in ct if not u.get('slab')]
    print(f'\n== {n}: count_tokens {len(ct)}, compressed {sum(1 for e in ev if e.get("compressed"))}, '
          f'third-probe bodies {len(third)}, median {st.median(third) / 1024 if third else 0:.1f} KiB, max {max(third) / 1024 if third else 0:.1f} KiB')
    print(f'{"tag":6}{"rnd":>5}{"st":>5}{"turns":>6}{"imgs":>5}{"ms":>7}{"probe":>8}{"think":>6}{"S":>8}{"K*think":>9}{"dev":>6}  img stub/est')
    rows = []
    for (tag, r), e, u in zip(SEQ, ev, main):
        billed = (e.get('input_tokens') or 0) + (e.get('cache_create_tokens') or 0) + (e.get('cache_read_tokens') or 0)
        ps = e.get('sent_probe_status', '-')
        S = billed - (e.get('sent_count_tokens') or 0) - (e.get('sent_image_tokens_est') or 0) if ps == 'ok' else None
        exp = K * u.get('think', 0); dev = None if S is None else S - exp
        rows.append(dict(turns=e.get('collapsed_turns'), imgs=e.get('image_count'), reason=e.get('history_reason'),
                         ms=e.get('transform_ms') or 0, ps=ps, dev=dev, think=u.get('think', 0), r=r,
                         comp=e.get('compressed'), img_ok=(u.get('img') == e.get('sent_image_tokens_est'))))
        print(f'{tag:6}{r:>5}{e.get("status"):>5}{str(e.get("collapsed_turns")):>6}{str(e.get("image_count")):>5}'
              f'{str(e.get("transform_ms")):>7}{ps:>8}{u.get("think", 0):>6}{str(S):>8}{exp:>9}{str(dev):>6}  {u.get("img")}/{e.get("sent_image_tokens_est")}')
    R[n] = rows
    if n.startswith('new'):
        good = all(x['ps'] == 'ok' and abs(x['dev']) <= 10 and x['img_ok'] and x['think'] <= x['r'] for x in rows if x['comp'])
        verdict.append(f'{n}: {"PASS" if good else "FAIL"} (probe ok, |S - K*think| <= 10, image cost equal, think <= rounds)')
    else:
        verdict.append(f'{n}: {"PASS" if all(x["ps"] == "-" for x in rows) else "FAIL"} (old build writes no sent_* fields)')
for o, nw in (('old1', 'new1'), ('old2', 'new2')):
    if o in R and nw in R:
        same = all((a['turns'], a['imgs'], a['reason']) == (b['turns'], b['imgs'], b['reason']) for a, b in zip(R[o], R[nw]))
        print(f'{o} vs {nw}: images/turns/reason identical: {same}; transform_ms median {st.median([x["ms"] for x in R[o]])} vs {st.median([x["ms"] for x in R[nw]])}')
        verdict.append(f'{o}~{nw}: {"PASS" if same else "FAIL"} (same images and turns)')
print('\n' + '\n'.join(verdict))
```

- [ ] **Step 4: Run four alternating runs** (stub `:47898`, proxy `:47899`, live unit env, isolated HOME)

```bash
cd $T; NEW=/srv/pxpipe-worktrees/thinking-baseline-floor/dist/node.js; OLD=/srv/pxpipe/dist/node.js
sha256sum $OLD $NEW | cut -c1-16    # OLD must be e0fbb34a45705585, NEW the Task 6 sha
for x in "old1 $OLD" "new1 $NEW" "old2 $OLD" "new2 $NEW"; do set -- $x; ./run.sh $1 $2 | tee -a runs.log; done
grep -c "client rc=0" runs.log      # expect 4
```

Expected: the two shas as noted, `4`. Peak RSS per run is in `runs.log`.

- [ ] **Step 5: Analyse**

Run: `cd $T && python3 ana.py $T old1 new1 old2 new2 | tee out-ana.txt; echo "rc=${PIPESTATUS[0]}"`

Expected: rc=0; every verdict line PASS; new runs show 3 count_tokens calls per compressed request (old: 2); `dev` at most ±10 on every new row; `think` below `rnd` on rows with collapsed history; image cost stub == estimate. If any line says FAIL: stop, do not go on to Task 8, report the table to the operator.

- [ ] **Step 6: Record the result**

Write `$T/README.txt` (folder, bundles with sha, what each file is, the verdict lines, peak RSS old vs new, median third-probe KiB). Append to the spec a section `## Side-port trial <date>` with the same facts (one table: run, compressed, probes per request, max |dev|, transform_ms median, peak RSS), then:

```bash
cd $W && git add docs/superpowers/specs/2026-10-07-thinking-baseline-floor-design.md && git commit -q -F - <<'EOF'; echo "rc=$?"
docs(spec): side-port trial of the thinking-aware floor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BTHhT9kQufnhcWf5kXS2ut
EOF
```

---

### Task 8: Rollout (only after the operator says go)

**Files:** `/srv/pxpipe` (ff-merge, dist), `/srv/pxpipe-rollback/` (rollback copy, log). The unit env stays as it is.

- [ ] **Step 1: STOP and ask the operator for go.** Show: the Task 7 verdict lines, the new bundle sha, and that a restart breaks running requests and every running session rebuilds its cache once. Continue only on an explicit go.

- [ ] **Step 2: Pre-checks and rollback copy**

```bash
cd /srv/pxpipe && git status --short | head; git branch --show-current; git rev-parse --short HEAD
git check-ignore -q dist && echo "dist ignored"
sha256sum dist/node.js | cut -c1-16                         # expect e0fbb34a45705585
RB=/srv/pxpipe-rollback/dist-8185f36-j12
[ -e $RB ] || cp -a /srv/pxpipe/dist $RB; sha256sum $RB/node.js | cut -c1-16   # expect e0fbb34a45705585
/srv/pxpipe-rollback/rollout.sh check; echo "rc=$?"
```

Expected: empty status, `main`, `8185f36`, `dist ignored`, both shas `e0fbb34a45705585`, check healthy rc=0. Any deviation: stop and report.

- [ ] **Step 3: Bring source and bundle to the trialled state**

```bash
cd /srv/pxpipe && git merge --ff-only feat/thinking-baseline-floor; echo "merge rc=$?"
rsync -a --delete /srv/pxpipe-worktrees/thinking-baseline-floor/dist/ /srv/pxpipe/dist/; echo "rsync rc=$?"
NEW16=$(sha256sum /srv/pxpipe/dist/node.js | cut -c1-16); echo $NEW16   # must equal the Task 6/7 sha
```

If the sha differs: `rsync -a --delete $RB/ /srv/pxpipe/dist/`, stop, report.

- [ ] **Step 4: Restart via the rollout script (survives this session)**

```bash
systemd-run --unit=pxpipe-rollout-thinking-floor --collect /srv/pxpipe-rollback/rollout.sh go $NEW16 /srv/pxpipe-rollback/dist-8185f36-j12 e0fbb34a45705585
sleep 60; tail -6 /srv/pxpipe-rollback/rollout.log
P=$(systemctl show pxpipe -p MainPID --value); tr '\0' '\n' < /proc/$P/environ | grep '^PXPIPE_GPT'
```

Expected: `ROLLOUT OK`, and the env line still `{"claude-opus-5":{"historyStripCols":195,"historyStyle":{"font":"jetbrains-mono-12"}}}`. On `ROLLED BACK`: the script restored the old bundle; reset source with `git -C /srv/pxpipe reset --hard 8185f36` only after showing the operator the log.

Manual way back later: `rsync -a --delete /srv/pxpipe-rollback/dist-8185f36-j12/ /srv/pxpipe/dist/` then `systemd-run --unit=pxpipe-rollback-thinking-floor --collect /srv/pxpipe-rollback/rollout.sh go e0fbb34a45705585 /srv/pxpipe-rollback/dist-8185f36-j12 e0fbb34a45705585`.

---

### Task 9: Live check and notes

**Files:** `/srv/pxpipe-rollback/analysis-<YYYY-MM-DD>/floor.py` + output; memory note `/root/.claude/projects/-srv-orchestrator-bybit/memory/pxpipe-ersparnis-einbruch-2026-09.md` and its line in `MEMORY.md`.

- [ ] **Step 1: Write `floor.py`**

```python
import json, sys, collections, statistics as st
T0 = sys.argv[1]   # rollout time, e.g. 2026-10-09T10:00
first_seen = {}; rows = []
for f in ('/root/.pxpipe/events.jsonl.1', '/root/.pxpipe/events.jsonl'):
    try:
        for l in open(f, errors='replace'):
            try: e = json.loads(l)
            except Exception: continue
            if e.get('path') != '/v1/messages': continue
            k = (e.get('first_user_sha8'), e.get('model'))
            first_seen.setdefault(k, e.get('ts', ''))
            if e.get('ts', '') >= T0: rows.append(e)
    except FileNotFoundError: pass
billed = lambda e: (e.get('input_tokens') or 0) + (e.get('cache_create_tokens') or 0) + (e.get('cache_read_tokens') or 0)
S = lambda e: billed(e) - (e.get('sent_count_tokens') or 0) - (e.get('sent_image_tokens_est') or 0)
print(f'{len(rows)} requests since {T0}')
print('third probe status per model:', dict(collections.Counter((e.get('model'), e.get('sent_probe_status')) for e in rows if e.get('status') == 200)))
ok = [e for e in rows if e.get('status') == 200 and e.get('sent_probe_status') == 'ok']
fl = [e for e in rows if e.get('status') == 200 and e.get('sent_probe_status') == 'failed']
print(f'failed share: {len(fl)}/{len(ok) + len(fl)}')
print('\n-- control: first request of sessions born after rollout (no earlier replies -> S ~ 0)')
by = collections.defaultdict(list)
for e in ok:
    if first_seen.get((e.get('first_user_sha8'), e.get('model'))) == e.get('ts'): by[e.get('model')].append(e)
for m, v in sorted(by.items()):
    s = sorted(S(e) for e in v); rel = sorted(S(e) / max(1, billed(e)) * 100 for e in v)
    print(f'{m:22} n={len(v):4} S median {st.median(s):7.0f} p10 {s[len(s) // 10]:7.0f} p90 {s[len(s) * 9 // 10]:7.0f}  S/billed median {st.median(rel):5.2f}%')
print('\n-- saving raw vs incl. thinking (probe-OK rows; uncompressed S = billed - baseline)')
size = lambda b: '<200k' if b < 2e5 else '200-400k' if b < 4e5 else '400k-1M' if b < 1e6 else '>=1M'
agg = collections.defaultdict(lambda: [0, 0, 0, 0])
for e in rows:
    b = e.get('baseline_tokens') or 0
    if e.get('status') != 200 or e.get('baseline_probe_status') != 'ok' or b <= 0: continue
    s = max(0, S(e)) if e.get('compressed') and e.get('sent_probe_status') == 'ok' else (0 if e.get('compressed') else max(0, billed(e) - b))
    a = agg[(e.get('model'), size(b))]; a[0] += 1; a[1] += b; a[2] += b + s; a[3] += billed(e)
for k, (n, b, bf, act) in sorted(agg.items(), key=str):
    print(f'{str(k):40} n={n:5} saved raw {(1 - act / b) * 100:6.1f}%  incl. thinking {(1 - act / bf) * 100:6.1f}%')
```

- [ ] **Step 2: Run it after a few hours of Opus traffic, plus `/proxy-stats`**

```bash
A=/srv/pxpipe-rollback/analysis-$(date -u +%F); mkdir -p $A && cd $A   # floor.py from Step 1 lives here
python3 floor.py <rollout-ts> | tee out-floor.txt; echo "rc=${PIPESTATUS[0]}"
curl -s 127.0.0.1:47821/proxy-stats | python3 -c "import json,sys; d=json.load(sys.stdin); print({k: v for k, v in d.items() if 'thinking' in k or k in ('saved_pct_input_only', 'compressed_requests')})"
```

Expected: control S/billed median close to 0 (a few tenths of a percent at most) for every model, `claude-opus-5` rows (if any) S ≈ 0 throughout; failed share small (the 2026-10-06 baseline was 844 failed of 35,724 probes, about 2.4 %); `saved_pct_input_only_thinking_min` ≥ `saved_pct_input_only`. A control median far from 0 means the image formula or the removal is off: report, do not explain it away.

- [ ] **Step 3: Notes**

Write the result into `$A/README.txt`, into the memory note (new dated section: rollout time, PID, bundle sha, rollback command, control result, corrected Opus saving per size class), and update its line in `MEMORY.md`. Report to the operator in plain words: what the dashboard now shows, what the control says, what stays open (Variant B, proxy-off control run).

## Amendments after the final review (2026-10-08)

- Task 7, extra measurements old vs new on the same requests: `duration_ms` p50 and p99, TTFB (`first_byte_ms`) on the three largest bodies, and a screenshot of the hero card from the side-port dashboard (`http://127.0.0.1:47899/dashboard`) showing the new line. Check that the two dashed separators read acceptably; otherwise give the new line its own class.
- Task 9, floored-mean control: on first-request-of-session rows (all models) and on all rows of models without the thinking gap (`claude-opus-5`, Sonnet, Haiku), report Σmax(0, S) / Σbilled. Acceptance: below 0.1 %. Above that, a noise deadband is added to `sentProbeSurcharge` before the number is trusted.
- Task 9, headline coverage: the hourly share of rows with `baseline_probe_status` `failed` or `partial`, 24 h before vs after the rollout. Rollback trigger: more than +1 percentage point. If it trips, add a 60 s third-probe backoff after any count_tokens 429.
- Task 9, collapse shrink: count how often `collapsed_turns` decreases between consecutive measured requests of one session (the known limit (2) in docs/CACHING_AND_SAVINGS.md).
- Task 6 battery: `.superpowers/sdd/2026-10-08-thinking-baseline-floor/task-6-mut.py` (9 mutants) replaced the inline 4-mutant script after the review fixes. The expected suite count is the post-fix count.
