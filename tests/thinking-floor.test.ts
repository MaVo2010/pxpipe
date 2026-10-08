import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  floorBaselineSizes,
  isSurchargeMeasured,
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
  it('measured means compressed, probe ok and both numbers present; unknown compression adds nothing', () => {
    expect(isSurchargeMeasured({ ...row, sent_count_tokens: 0 })).toBe(false);
    expect(isSurchargeMeasured({ ...row, sent_image_tokens_est: undefined })).toBe(false);
    expect(isSurchargeMeasured({ ...row, compressed: undefined })).toBe(false);
    expect(isSurchargeMeasured(row)).toBe(true);
    expect(rawThinkingSurcharge({ baseline_tokens: 1000, input_tokens: 1100 })).toBe(0);
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
    expect(s.saved_pct_input_only_thinking_min).toBe(68);
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

  it('prior with a failed third probe: assumes the current S was cached already', async () => {
    const d = new DashboardState();
    d.update(live({ ...R1, status: 'failed' }) as never);
    d.update(live(R2) as never);
    const s = await stats(d);
    // R1 floor = headline 122500; R2 prior 90000 + S 2000 = 92000 reused →
    // 9200 + 4000×1.25 + 10000 = 24200.
    expect(s.baseline_input_weighted).toBe(146500);
    expect(s.baseline_input_weighted_thinking_min).toBe(146700);
  });

  it('prior without sent fields: same conservative split', async () => {
    const d = new DashboardState();
    d.update(live({ ...R1, status: undefined }) as never);
    d.update(live(R2) as never);
    const s = await stats(d);
    expect(s.baseline_input_weighted).toBe(146500);
    expect(s.baseline_input_weighted_thinking_min).toBe(146700);
  });

  it('row whose own S was not measured counts exactly as in the headline', async () => {
    const d = new DashboardState();
    d.update(live(R1) as never);
    d.update(live({ ...R2, status: 'failed' }) as never);
    const s = await stats(d);
    // R1 floor 123750 + R2 headline 24000.
    expect(s.baseline_input_weighted).toBe(146500);
    expect(s.baseline_input_weighted_thinking_min).toBe(147750);
    expect(s.thinking_floor_measured_requests).toBe(1);
    expect(s.thinking_floor_eligible_requests).toBe(2);
  });

  it('restart: a pre-probe row in the log gives the conservative prior', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-floor-'));
    const file = path.join(dir, 'events.jsonl');
    const t1 = {
      ts: new Date(Date.now() - 5000).toISOString(), method: 'POST', path: '/v1/messages',
      model: 'claude-fable-5-1', status: 200, duration_ms: 1000, compressed: true,
      input_tokens: 2000, output_tokens: 100, cache_create_tokens: 30000, cache_read_tokens: 0,
      first_user_sha8: SID, system_sha8: SYS, baseline_tokens: 100000,
      baseline_cacheable_tokens: 90000, baseline_probe_status: 'ok',
    };
    fs.writeFileSync(file, JSON.stringify(t1) + '\n');
    try {
      const d = new DashboardState();
      await d.replay(file);
      d.update(live(R2) as never);
      const s = await stats(d);
      expect(s.baseline_input_weighted).toBe(24000);
      expect(s.baseline_input_weighted_thinking_min).toBe(24200);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
