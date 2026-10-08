# Thinking-aware baseline floor - design

Status: agreed with the operator in chat, 2026-10-06 to 2026-10-08. Not built.
Branch `feat/thinking-baseline-floor`, based on `live/0.14.0` @ `8185f36` (the build
running on this host). Not pushed.

## Problem

The dashboard's counterfactual ("what this request would have cost without pxpipe")
comes from a `count_tokens` probe on the original body (`baseline_tokens`). For
`claude-opus-5-5` and `claude-fable-5-1` the provider **bills** the thinking blocks
of earlier assistant replies as input, but `count_tokens` **does not count** them.
So the baseline is too low for those models and the shown saving is too low, too.
For requests whose history is forwarded unchanged, a request even looks like a loss
when nothing was lost.

Evidence (raw tokens, `/srv/pxpipe-rollback/analysis-2026-10-05/denk.py`,
output `out-denk.txt`):

| measurement | result |
|---|---|
| growth of (billed - baseline) per round, divided by the previous reply's `output_tokens`, consecutive requests of one session, reply >= 200 tokens, since 2026-09-24 | `claude-opus-5-5` median 0.22, `claude-fable-5-1` median 0.44, `claude-opus-5` (same build, same profile) 0.00 |
| one session, each reply matched by timestamp | after a reply without a thinking block the gap grows by 0 (median, n=21); after a reply with one by about its thinking tokens (median 216, n=29) |
| Opus `prefix_too_short`, raw saving vs baseline, and vs baseline + measured gap | window D: -12.8 % -> +6.4 %; window E: -2.7 % -> +6.4 % |

`thinking_chars_measured` is only written when it is > 0 (`src/core/tracker.ts:401`),
and Opus 5.5 often returns thinking blocks with a signature but no readable text, so
the log cannot tell exactly which reply carried how much thinking. Estimating the gap
from `output_tokens` minus visible text was tried and is too coarse (median error
about 200 tokens per request).

## Decisions

- **Goal: show alongside.** The headline number and every existing field stay
  unchanged and comparable with history. A second, corrected number is added next
  to them.
- **Third probe for every model**, not a model list. `claude-opus-5` and any model
  without the gap must measure about 0, which is the built-in control.
- **Variant A, a lower bound.** Measure the gap only where both the count and the
  bill are known: on the text pxpipe actually sends. Variant B (remember each thinking
  block's cost by signature hash and add it back once pxpipe collapses it) stays a
  possible later step; A is its foundation. Variant C (correct unchanged requests
  only) was rejected because it gives no total.

## Part 1 - measurement in the proxy

**Uncompressed requests.** The sent body is the original, so the existing
`baseline_tokens` already is the count of the sent body. No extra probe; status
`skipped`.

**Compressed requests.** A third `count_tokens` probe runs on the sent body with
pxpipe's own rendered images removed (the PNGs listed in `info.imagePngs`: slab
pages and collapsed history pages). Images the client sent (for example
screenshots) stay in. A message whose content becomes empty gets a single `"."`
text block (a few tokens of noise, always in the same direction). The cost of the
removed images is computed with `anthropicVisionTokens`
(`src/core/anthropic-vision.ts:40`) from `info.imageDims`, which pxpipe knows
exactly because it rendered them. The probe upload therefore grows only by the text
part, not by the image megabytes.

The probe uses the same body filter as the existing probes
(`buildBaselineCountTokensBody`, `src/core/measurement.ts`), the same upstream
routing and headers (`src/core/proxy.ts:1862-1866`), and runs alongside the forward.
The client's response never waits for it.

**Log fields (measured values only, no derived correction):**

- `sent_count_tokens` - `count_tokens` of the sent body without pxpipe images
- `sent_image_tokens_est` - computed cost of the removed pxpipe images
- `sent_probe_status` - `ok` / `failed` / `skipped`

The gap is derived later as billed input - (`sent_count_tokens` +
`sent_image_tokens_est`), so the log stays recomputable if the formula changes.

**Failure.** A failed or timed-out third probe sets `failed`; the request is
otherwise unaffected. Failures are counted and shown (Part 2).

## Part 2 - arithmetic and display

**Surcharge S per request (the missing thinking tokens):**

- compressed, probe `ok`: S = billed input - (`sent_count_tokens` +
  `sent_image_tokens_est`), floored at 0
- compressed, probe `failed` or fields missing (older rows): S = 0. This is what
  keeps the result a lower bound; these requests are counted.
- uncompressed: the dashboard already sets the counterfactual equal to the actual
  cost for these rows, so nothing changes.

**Corrected baseline.** S is added to both the full baseline and its cacheable part,
because the thinking blocks sit in earlier replies, i.e. before the last cache
marker. Then the existing formula runs unchanged (`computeBaselineInputEffWithCacheTier`,
`src/dashboard.ts:799`). Cold/warm detection stays as it is (cache reads). New is
one more per-session value: the previous request's cacheable size including S,
which the reused/grown split needs.

**Display.**

- The headline stays unchanged.
- A new line under it, English like the rest of the UI, for example
  "Counting earlier replies' thinking: at least 21 % fewer · 1,412 of 1,430 imaged
  requests measured".
- "Show the math" gets one more row with the corrected baseline, marked as a lower
  bound.
- `/proxy-stats` gets the matching fields (for example
  `saved_pct_input_only_thinking_min`) so analysis scripts can read them directly.

**Long-run view (`src/stats.ts`, `/api/stats.json`).** It reads the whole log across
restarts, so it answers the question without waiting days for the live counters. It
gets a corrected line on raw tokens:

- uncompressed: S = billed - baseline, no extra probe needed and exact. These rows
  show as a loss today and move to about 0.
- compressed: S from the measurement; missing -> 0.

## Part 3 - tests, side-port trial, rollout

**Tests first** (`npx vitest run` in the worktree):

1. Probe body (`src/core/measurement.ts`): removes exactly the images in
   `info.imagePngs`, keeps client images, inserts `"."` where content becomes empty.
   Image cost equals the sum of `anthropicVisionTokens` over `imageDims`.
2. Proxy against a stub upstream: compressed request -> three probes, the third
   without pxpipe images and correspondingly small, three new fields with `ok`.
   Uncompressed -> two probes, `skipped`. Third probe fails -> `failed`, client
   response unchanged.
3. Dashboard: corrected number equals a hand-computed case; all existing fields
   unchanged (compared against the old build); missing field -> corrected equals old;
   warm cache uses the new per-session value.
4. `src/stats.ts`: uncompressed rows corrected to about 0; compressed with and
   without the fields.
5. Mutation check, each must turn a test red: S not added to the cacheable part; no
   floor at 0; wrong per-session value; pxpipe images not removed.
6. Then typecheck and `npm run build`, each exit code checked separately.

**Side-port trial** (as in OPS5: stub upstream `:47898`, proxy `:47899`, isolated
HOME, `PXPIPE_SESSION_STATE=off`):

- The stub gets two additions: it answers `count_tokens` deterministically and,
  like the real provider, ignores thinking blocks there; when billing it adds a
  fixed number of tokens per thinking block in the sent body. The test client sends
  replies that carry thinking blocks.
- Expectation: with unchanged history pxpipe measures exactly the stub's surcharge;
  with collapsed history less, never more.
- Old vs new on the same requests: `transform_ms` and images equal; 3 instead of 2
  probes per compressed request; extra probe upload per request measured; peak RSS.

**Rollout.** The new bundle goes live via `rollout.sh go <sha16>` with automatic
rollback. The unit environment stays as it is (`jetbrains-mono-12` @ 195).

**Live check.** The first request of each session has no earlier replies and
therefore no thinking surcharge, so S must be about 0 there for every model. This
checks the image formula independently of whether `claude-opus-5` still has traffic.
Then the same per-length breakdown as in the 2026-10-05 analysis, plus the probe
failure rate (429s). Readable after a few hours of Opus traffic.

## Not in scope

- Changing the headline number or any existing field.
- Recovering thinking tokens that pxpipe collapses away (Variant B).
- A proxy-off control run on real traffic (costs real tokens; can follow later).
