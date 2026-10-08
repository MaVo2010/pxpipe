import { describe, it, expect } from 'vitest';
import { renderHeaderFragment, renderSessionSummaryFragment } from '../src/dashboard/fragments.js';
import type { StatsPayload } from '../src/dashboard/types.js';

/**
 * The hero reads the SAME cache-weighted lifetime pair as the header strip
 * (serveStats), not the per-session payload — so it can't disagree with the
 * "$ saved" tiles and it stops swinging on tiny samples. The old bug divided
 * raw count_tokens (cache-blind) by sent tokens and could claim a big "fewer
 * tokens" win on a session the Saved column showed as a net loss. These pin
 * direction to `baseline_input_weighted` vs `actual_input_weighted`.
 */
function payload(p: Partial<StatsPayload>): StatsPayload {
  return {
    compressed_requests: 1,
    output_weighted: 695, // 139 raw × 5 output_multiplier
    pricing_assumptions: { output_multiplier: 5 },
    ...p,
  } as StatsPayload;
}

describe('renderSessionSummaryFragment hero', () => {
  it('shows "fewer tokens" when the weighted image beat weighted text', () => {
    const html = renderSessionSummaryFragment(
      payload({ baseline_input_weighted: 7000, actual_input_weighted: 1800 }),
    );
    expect(html).toContain('fewer tokens');
    expect(html).not.toContain('more tokens');
    expect(html).toContain('74%'); // 1 - 1800/7000
  });

  it('flips to "more tokens" on a warm net-loss session (matches Saved "-")', () => {
    // The exact trap: raw text (e.g. 7.2k) would look like a huge win, but the
    // cache-weighted text baseline (1,546) is below what imaging actually sent (1,863).
    const html = renderSessionSummaryFragment(
      payload({ baseline_input_weighted: 1546, actual_input_weighted: 1863 }),
    );
    expect(html).toContain('more tokens');
    expect(html).not.toContain('fewer tokens');
    expect(html).toContain('hero-neg'); // red styling on a loss
  });

  it('never lumps output into the headline ratio', () => {
    // Same input pair, wildly different output — headline % must not move.
    const a = renderSessionSummaryFragment(
      payload({ baseline_input_weighted: 2000, actual_input_weighted: 1000, output_weighted: 50 }),
    );
    const b = renderSessionSummaryFragment(
      payload({ baseline_input_weighted: 2000, actual_input_weighted: 1000, output_weighted: 45000 }),
    );
    expect(a).toContain('50%');
    expect(b).toContain('50%');
  });

  it('renders the warming-up state with no measured requests', () => {
    const html = renderSessionSummaryFragment(payload({ compressed_requests: 0 }));
    expect(html).toContain('Warming up');
    expect(html).not.toContain('fewer tokens');
  });
});

describe('thinking floor line', () => {
  const floor = {
    baseline_input_weighted: 7000, actual_input_weighted: 1800,
    baseline_input_weighted_thinking_min: 7400, saved_pct_input_only_thinking_min: 75.7,
    thinking_floor_measured_requests: 1412, thinking_floor_eligible_requests: 1430,
  };
  it('shows the lower bound under the unchanged headline', () => {
    const html = renderSessionSummaryFragment(payload(floor));
    expect(html).toContain('74%'); // headline unchanged: 1 - 1800/7000
    expect(html).toContain("Counting earlier replies' thinking: at least 75% fewer · 1,412 of 1,430 imaged requests measured");
  });
  it('words a negative lower bound as "at most … more"', () => {
    const html = renderSessionSummaryFragment(payload({ ...floor, baseline_input_weighted_thinking_min: 1740 }));
    expect(html).toContain('at most 4% more'); // 1 - 1800/1740 = -3.45%
  });
  it('rounds the lower bound toward the safe side', () => {
    const tiny = renderSessionSummaryFragment(payload({ ...floor, baseline_input_weighted_thinking_min: 1799 }));
    expect(tiny).toContain('at most 1% more'); // 1 - 1800/1799 = -0.056%
    const exact = renderSessionSummaryFragment(payload({ ...floor, baseline_input_weighted_thinking_min: 7200 }));
    expect(exact).toContain('at least 75% fewer'); // 1 - 1800/7200 = 75.0%
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
