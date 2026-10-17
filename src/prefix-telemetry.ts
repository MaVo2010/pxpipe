/**
 * Prefix-divergence telemetry (Node host only).
 *
 * Question it answers: when a request re-creates cache it should have read, did
 * the bytes we sent change, and where? `cachePrefixDigest` (core) already hashes
 * tools / system / the imaged head on compressed requests. What it cannot say is
 * whether an EARLIER message of the live tail changed (client-side rewrites such
 * as cleared tool results) or whether the prefix was byte-identical and the cache
 * was lost upstream. This module compares each outgoing request, message by
 * message, with the previous request of the same conversation and records the
 * first point of difference:
 *
 *   'new'    no previous request of this conversation in memory
 *   'none'   tools, system, head and every previous message unchanged (pure append)
 *   'tools' | 'system' | 'head'   that layer changed (head = model, thinking,
 *            tool_choice, context_management — settings that key the cache)
 *   'm<i>'   message i is the first that differs, or the first missing one
 *
 * `cache_control` is skipped while hashing: the client moves its marker to the
 * newest message every turn, and the marker is not part of the cached content.
 * A leading billing-header system block is skipped for the same reason as in
 * cachePrefixDigest (the endpoint lifts it out of the cache key).
 *
 * Runs after the response, from the proxy's event finalizer, on the exact bytes
 * that were sent. Hashing walks the parsed object and feeds strings straight into
 * an incremental sha256 instead of re-stringifying: ~15 ms for a 20 MiB body
 * against ~100 ms with JSON.stringify per message (measured 2026-10-17).
 */
import { createHash, type Hash } from 'node:crypto';
import { isEndpointIgnoredBillingBlock, type TransformInfo } from './core/transform.js';

export interface PrefixFingerprint {
  head: string;
  tools: string;
  system: string;
  msgs: string[];
}

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

function digest(v: unknown): string {
  const h = createHash('sha256');
  feed(h, v);
  return h.digest('hex').slice(0, 8);
}

export function prefixFingerprint(req: Record<string, unknown>): PrefixFingerprint {
  let system: unknown = req.system;
  if (Array.isArray(system) && system.length > 0 && isEndpointIgnoredBillingBlock(system[0])) {
    system = system.slice(1);
  }
  const messages = Array.isArray(req.messages) ? req.messages : [];
  return {
    head: digest([req.model, req.thinking, req.tool_choice, req.context_management]),
    tools: digest(req.tools ?? null),
    system: digest(system ?? null),
    msgs: messages.map((m) => digest(m)),
  };
}

/** Last fingerprint per conversation key, bounded (least recently seen goes first). */
export class PrefixDivergence {
  private readonly last = new Map<string, PrefixFingerprint>();
  constructor(private readonly cap = 512) {}

  observe(key: string, fp: PrefixFingerprint): string {
    const prev = this.last.get(key);
    this.last.delete(key);
    this.last.set(key, fp);
    if (this.last.size > this.cap) this.last.delete(this.last.keys().next().value as string);
    if (!prev) return 'new';
    if (prev.tools !== fp.tools) return 'tools';
    if (prev.system !== fp.system) return 'system';
    if (prev.head !== fp.head) return 'head';
    for (let i = 0; i < prev.msgs.length; i++) {
      if (fp.msgs[i] !== prev.msgs[i]) return `m${i}`;
    }
    return 'none';
  }
}

/** Host hook for createProxy's `prefixTelemetry`: fills prefixDiverge / prefixMsgs / prefixMs. */
export function makePrefixTelemetry(cap = 512): (body: Uint8Array, info: TransformInfo) => void {
  const state = new PrefixDivergence(cap);
  return (body, info) => {
    const t0 = performance.now();
    let req: Record<string, unknown>;
    try {
      req = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
    } catch {
      return; // not ours to judge — leave the fields unset
    }
    if (!req || typeof req !== 'object' || !Array.isArray(req.messages)) return;
    const fp = prefixFingerprint(req);
    const conv = info.sessionStateKey ?? info.firstUserSha8 ?? `m0:${fp.msgs[0] ?? '-'}`;
    const key = `${info.clientSessionSha8 ?? '-'}|${String(req.model ?? '')}|${conv}`;
    info.prefixDiverge = state.observe(key, fp);
    info.prefixMsgs = fp.msgs.length;
    info.prefixMs = Math.round((performance.now() - t0) * 10) / 10;
  };
}
