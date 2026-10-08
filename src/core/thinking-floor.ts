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
  pin_chars?: number;
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
  // pxpipe's pin block is in the sent body, so billed - baseline would count it.
  if ((r.pin_chars ?? 0) > 0) return 0;
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
