/**
 * Prefix-divergence telemetry (Node host only).
 *
 * Question it answers: when a request re-creates cache it should have read, did
 * the bytes we sent change, and where? `cachePrefixDigest` (core) already hashes
 * tools / system / the imaged head on compressed requests. What it cannot say is
 * whether an EARLIER message of the live tail changed (client-side rewrites such
 * as cleared tool results) or whether the prefix was byte-identical and the cache
 * was lost upstream. This module compares each outgoing request, message by
 * message, with the recent requests of the same conversation:
 *
 *   prefix_diverge  against the recent request sharing the longest prefix (ties:
 *                   the most recent) —
 *     'new'    nothing of this conversation in memory
 *     'none'   that request is fully contained (pure append)
 *     'head' | 'tools' | 'system'   that layer differs (head = every top-level
 *              field except messages/tools/system/metadata/stream/max_tokens,
 *              plus the anthropic-beta header)
 *     'm<i>'   message i is the first that differs, or the first missing one
 *   prefix_prev_msgs   that request's message count
 *   prefix_reuse_msgs  the longest recent request fully contained in this one —
 *                      the part the prompt cache could have served
 *
 * Why several requests per conversation: a fork (or a compaction side request)
 * shares the parent's opening, so it shares the key. Against a single stored
 * request, parent and fork would alternately report each other as rewrites. With
 * the last few kept, each finds its own predecessor. One ambiguity remains by
 * construction: the parent's first turn after a fork shares one more message with
 * the fork than with its own predecessor and reads 'm<prev-1>'; prefix_reuse_msgs
 * still shows the full reusable prefix there.
 *
 * Only 2xx requests become references (a 413 never left pxpipe, a 5xx wrote no
 * cache); failed ones are still judged. `cache_control` is skipped while hashing
 * (the client moves its marker every turn), so is a leading billing-header system
 * block (the endpoint lifts it out of the cache key, see cachePrefixDigest).
 *
 * Runs after the response, from the proxy's event finalizer, on the exact bytes
 * that were sent. Hashing walks the parsed object and feeds strings straight into
 * an incremental sha256 instead of re-stringifying: ~15 ms for a 20 MiB body
 * against ~100 ms with JSON.stringify per message (measured 2026-10-17). Message
 * hashes are kept as 32-bit values (4 bytes each) — collisions at that width are
 * irrelevant for telemetry.
 */
import { createHash, type Hash } from 'node:crypto';
import {
  isEndpointIgnoredBillingBlock,
  prefixConversationKeys,
  sha8,
  type TransformInfo,
} from './core/transform.js';
import { clientSessionId } from './core/client-session.js';

export interface PrefixFingerprint {
  head: number;
  tools: number;
  system: number;
  msgs: Uint32Array;
}

/** Top-level fields that do not key the prompt cache (or are hashed separately). */
const NOT_HEAD = new Set(['messages', 'tools', 'system', 'metadata', 'stream', 'max_tokens']);

function feed(h: Hash, v: unknown): void {
  if (typeof v === 'string') {
    h.update(`s${v.length}:`);
    h.update(v);
    return;
  }
  if (v === null || typeof v !== 'object') {
    h.update(`${typeof v}:${String(v)};`);
    return;
  }
  if (Array.isArray(v)) {
    h.update(`[${v.length}`);
    for (const x of v) feed(h, x);
    h.update(']');
    return;
  }
  const keys = Object.keys(v).filter((k) => k !== 'cache_control');
  h.update(`{${keys.length}`);
  for (const k of keys) {
    h.update(`k${k.length}:${k}`);
    feed(h, (v as Record<string, unknown>)[k]);
  }
  h.update('}');
}

function digest(v: unknown): number {
  const h = createHash('sha256');
  feed(h, v);
  return h.digest().readUInt32BE(0);
}

export function prefixFingerprint(req: Record<string, unknown>, beta?: string | null): PrefixFingerprint {
  let system: unknown = req.system;
  if (Array.isArray(system) && system.length > 0 && isEndpointIgnoredBillingBlock(system[0])) {
    system = system.slice(1);
  }
  const head: unknown[] = [beta ?? null];
  for (const k of Object.keys(req)) if (!NOT_HEAD.has(k)) head.push(k, req[k]);
  const messages = Array.isArray(req.messages) ? req.messages : [];
  const msgs = new Uint32Array(messages.length);
  for (let i = 0; i < messages.length; i++) msgs[i] = digest(messages[i]);
  return { head: digest(head), tools: digest(req.tools ?? null), system: digest(system ?? null), msgs };
}

export interface PrefixVerdict {
  diverge: string;
  prevMsgs?: number;
  reuseMsgs?: number;
}

/** How far `prev` matches `cur` in cache order (head, tools, system, messages). */
function match(prev: PrefixFingerprint, cur: PrefixFingerprint): { score: number; label: string; full: boolean } {
  if (prev.head !== cur.head) return { score: 0, label: 'head', full: false };
  if (prev.tools !== cur.tools) return { score: 1, label: 'tools', full: false };
  if (prev.system !== cur.system) return { score: 2, label: 'system', full: false };
  let k = 0;
  while (k < prev.msgs.length && k < cur.msgs.length && prev.msgs[k] === cur.msgs[k]) k++;
  const full = k === prev.msgs.length;
  return { score: 3 + k, label: full ? 'none' : `m${k}`, full };
}

/** Recent requests per conversation key; keys bounded least-recently-seen first. */
export class PrefixDivergence {
  private readonly last = new Map<string, PrefixFingerprint[]>();
  constructor(
    private readonly capKeys = 512,
    private readonly perKey = 8,
  ) {}

  compare(
    key: string,
    fp: PrefixFingerprint,
    opts: { store?: boolean; fallbackKey?: string } = {},
  ): PrefixVerdict {
    const store = opts.store !== false;
    let cands = this.last.get(key);
    if (!cands && opts.fallbackKey !== undefined && opts.fallbackKey !== key) {
      cands = this.last.get(opts.fallbackKey);
      // Turn 1 had no reply yet, so it sits under the opening key: move it over.
      if (cands && store) this.last.delete(opts.fallbackKey);
    }
    let verdict: PrefixVerdict;
    if (!cands || cands.length === 0) {
      verdict = { diverge: 'new' };
    } else {
      let best: { score: number; label: string; prev: PrefixFingerprint } | undefined;
      let reuse = 0;
      for (const c of cands) {
        // Most recent first, so a strict '>' keeps the most recent on ties.
        const m = match(c, fp);
        if (m.full && c.msgs.length > reuse) reuse = c.msgs.length;
        if (!best || m.score > best.score) best = { score: m.score, label: m.label, prev: c };
      }
      verdict = { diverge: best!.label, prevMsgs: best!.prev.msgs.length, reuseMsgs: reuse };
    }
    if (store) {
      const next = [fp, ...(cands ?? [])].slice(0, this.perKey);
      this.last.delete(key);
      this.last.set(key, next);
      while (this.last.size > this.capKeys) this.last.delete(this.last.keys().next().value as string);
    }
    return verdict;
  }
}

/** Host hook for createProxy's `prefixTelemetry`: fills the prefix* fields of `info`. */
export function makePrefixTelemetry(
  capKeys = 512,
  perKey = 8,
): (body: Uint8Array, info: TransformInfo, ctx: { status: number; beta?: string | null }) => Promise<void> {
  const state = new PrefixDivergence(capKeys, perKey);
  return async (body, info, ctx) => {
    const t0 = performance.now();
    let req: Record<string, unknown>;
    try {
      req = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
    } catch {
      return; // not ours to judge — leave the fields unset
    }
    if (!req || typeof req !== 'object' || !Array.isArray(req.messages)) return;
    // The transform sets these right after parsing; paths that never parse
    // (compress=false) forward the original body, so derive them from it.
    if (!info.clientSessionSha8) {
      const sid = clientSessionId(req.metadata);
      if (sid) info.clientSessionSha8 = await sha8(sid);
    }
    let { prefixKey: key, prefixOpenKey: openKey } = info;
    if (!key || !openKey) ({ key, openKey } = await prefixConversationKeys(req as never));
    const fp = prefixFingerprint(req, ctx.beta);
    const sess = info.clientSessionSha8 ?? '-';
    const v = state.compare(`${sess}|${key}`, fp, {
      store: ctx.status >= 200 && ctx.status < 300,
      fallbackKey: `${sess}|${openKey}`,
    });
    info.prefixDiverge = v.diverge;
    info.prefixMsgs = fp.msgs.length;
    if (v.prevMsgs !== undefined) info.prefixPrevMsgs = v.prevMsgs;
    if (v.reuseMsgs !== undefined) info.prefixReuseMsgs = v.reuseMsgs;
    info.prefixMs = Math.round((performance.now() - t0) * 10) / 10;
  };
}
