# Savings drop audit, September 2026

Field note for anyone who upgraded past 0.13.x and saw the dashboard's
"fewer tokens" figure fall. It records what was seen, what caused it, what
this branch fixes, what it leaves open, and how to check the same things on
your own host. The code-level description lives in
[RENDER_SIZING.md](RENDER_SIZING.md); this is the story around it.

## Symptom

On one production host (Claude Code sessions, Opus and Fable, mostly long
tool-heavy conversations) the dashboard showed ~68% fewer tokens before an
upstream sync and ~16% after it. Nothing in the client, the models or the
usage pattern had changed on purpose. Measured from `events.jsonl` over
2026-08-20 → 09-08 (before) and 09-12 → 09-29 (after), on `/v1/messages`
requests only, in weighted input tokens (cache read ×0.1, cache create ×1.25):

| view | before | after |
|---|---|---|
| dashboard formula, recomputed from events | 68.3% | 16.4% |
| fair baseline (conversation chains rebuilt from the cache counters) | 68.8% | 23.2–25.0% |

So the drop is real, and the dashboard is additionally 7–9 points too
pessimistic. The 45.6-point fall decomposes as:

| cause | points |
|---|---|
| traffic mix: Opus share of the baseline went 22.7% → 64.2% | −16.5 |
| Opus requests ≥ 200k tokens: the byte cliff (below) | −18.4 |
| Opus < 200k | −6.5 |
| Fable ≥ 200k | −3.7 |
| Fable < 200k | −0.5 |

The traffic-mix part is not a bug and no code change brings it back.

## Cause 1, fixed here: the byte cliff

`maxImageBytes` (18 MiB, introduced with the atomic byte budget, #201) was
applied to the history collapse as a whole: render everything, weigh it,
and if it does not fit, throw all of it away and send the entire history as
text. `history_reason` reports that as `image_bytes`.

Opus pages weigh ~265 KiB at the median, so the cliff sits at roughly 57–70
images, before the image budget (80) ever trims anything. On the host above,
09-12 → 09-29: 5,753 refusals, 99.7% of them Opus, 44% at a freeze step of
160 or more where the whole range is one chunk. For Opus sessions ≥ 400k
tokens, 96.1% of requests were refused and the saving was 0.7% (56.6%
before the sync). Those are exactly the requests where compression is worth
the most, and each one had paid for the full render before being refused.

The fix (`fix(history): collapse in part when the byte budget is short`):
admit the collapse chunk by chunk on measured weight, oldest first, cut at
the last closed boundary that fits, halve an oversized chunk along the
freeze grid before giving up. The cut depends only on the messages in front
of it, so it does not move as the conversation grows and the pages before
it stay byte-identical (cache-stable). Such a request keeps
`history_reason: collapsed` and sets `history_byte_trimmed`; `image_bytes`
now means "not even the smallest closed prefix fit".

Second ceiling, same commit: the serialized request. Measured on the same
traffic, every request under 32 MiB was accepted and every one from
32.05 MiB up came back 413. `maxWireBytes` (default 30 MiB) narrows the byte
headroom every imaging path spends from; `wire_bound` marks requests where
it was the tighter limit. Raising `maxImageBytes` instead would not have
helped much: 18 MiB decoded is already 24 MiB of base64.

### The perf trap on the way (why there are two commits)

The first version admitted on measured weight and rendered to measure. On a
coarse freeze grid the first chunk is the entire range, so every request
rendered the whole history to admit a fraction of it: 160 MiB of pages for
17 admitted, more than the render cache holds. Suite green, mutation pass
green, and the proxy was five times slower. It was only caught by running
old and new builds on a side port against a stub upstream with two long
sessions (300–701 tool rounds, Opus):

| bundle | transform ms, sum of 12 requests | first | median of the rest |
|---|---|---|---|
| before the fix (refuses all) | 39,766 | 8,219 | 2,423 |
| fix, first version | 204,583 | 25,235 | 24,317 |
| fix + perf commit | 18,533 | 3,800 | 1,229 |

The perf commit skips a chunk without rendering when its estimated weight
exceeds 1.5× the room left (weight per character learned from what this
request already rendered; no constant works, the same traffic measured 49.5
bytes/char on one profile and 8.6 on another), probes a page's worth of base
chunks up front so the estimate exists, and base64-encodes only what is
admitted. What goes upstream is unchanged against the first version on all
12 requests.

**Before rolling out any change to the history path: run old vs. new on a
side port against a stub upstream with long sessions and compare
`transform_ms`.** Tests do not measure time.

## Follow-up, 2026-10-03: what the first days showed, and two more commits

**Reading after four days.** The dashboard counts from service start only.
On the host above the fixed build ran at 57.0% until an unrelated reboot and
at 40.8% after it. Of the 16.5-point gap, 9.0 came from traffic mix (fewer
sessions over 1M tokens after the reboot) and 7.5 from erosion that is built
into the fix: once a session reaches the byte budget the cut freezes, and
everything newer stays text. A Fable session went from 82.6% to 61.6% saved
while it grew from 1.3 to 1.6M tokens; an Opus 5.5 session from 40.7% to 18%.
Opus 5.5 was 31% of the traffic and saved 9–17%, because its legible pages
weigh about six times as much per character as Fable's.

**`perf(png)`: lighter pages, same pixels.** Rows now pick their PNG filter
individually instead of all using Average. On 587 real Opus history pages
from the host's image ring: 74.9% of the previous size, never heavier,
pixel-identical after decoding. Fable-geometry pages: 68.3%. More history
fits under the same byte budget at no token cost, since vision tokens are
priced by pixel dimensions.

**`fix(history)`: count the pages, not only their weight.** Lighter pages
exposed a second limit. The collapse plans its grid from an estimate of
characters per page that assumes the 5x8 cell; at `jetbrains-mono-14` a page
holds half of that (measured 2.0x, 2.31x with 0.14.0's extra 2 px rows). The
byte budget used to stop admission before that mattered. With lighter pages a
side-port run sent 113 and 115 images, past the provider's cap of 100.
Admission now counts the pages it has rendered as well as their bytes; a cut
by count sets `history_budget_trimmed`, a refusal by count says
`over_budget`. **Do not take the PNG commit without this one.** The estimate
itself is still font-blind; fixing that changes grid steps for live sessions
and is a separate step.

Side-port result with both commits (same 11-request sequence as above):
a long Opus session images 570 turns instead of 410, Fable sends the same
turns in 11.2 instead of 16.6 MiB, at most 83 images, the cached prefix
stays byte-identical turn to turn, median `transform_ms` unchanged.

**If you run Opus 5.5 on this branch, read this.** 0.14.0 moved every
non-Fable Claude model to the spaced 5x8 cell at 312 columns, on a gist
benchmark (93/98). This host measured exact values with its blinded canary
(26 values per run: commit SHAs, md5s, P&L figures, file:line, file names,
caps; `UNLESBAR` allowed), fresh Opus 5.5 reader per run:

| geometry for Opus 5.5 history | exact | **silently wrong** | admitted unreadable |
|---|---|---|---|
| spaced 5x8 @ 312 (0.14.0 default) | 11/26 | **3/26** | 12/26 |
| same, pre-registered repeat | 38/100 | **18/100** | 44/100 |
| `jetbrains-mono-14` @ 172 (override below) | 26/26 | **0/26** | 0/26 |

The errors are single-character substitutions (`7352.05` read as `7352.65`,
`fits.ts` as `fills.ts`) that look like valid values. If your agent relies on
exact ids, hashes or numbers from earlier in a session, set the override the
host above runs with (systemd needs the outer single quotes, or it strips the
inner ones and the JSON silently fails to parse):

```
Environment='PXPIPE_GPT_PROFILES={"claude-opus-5":{"historyStripCols":172,"historyStyle":{"font":"jetbrains-mono-14"}}}'
```

The key `claude-opus-5` matches `claude-opus-5-5` by prefix. Verify in the
running process, not in the unit file:
`tr '\0' '\n' < /proc/$(systemctl show pxpipe -p MainPID --value)/environ | grep GPT_PROFILES`.
It costs savings (heavier pages); that is the trade the numbers above buy.

## Causes 2 and 3, not touched by this branch

2. **Image budget 80 / cap 100** (`src/core/history.ts`). Before the sync
   this host ran 3,726 Fable requests with more than 100 images (maximum
   322) and got 200 OK; Opus went to 167 images and 23.77 MiB. The only real
   limit observed was HTTP 413. The budget pushes large Fable sessions into
   "one chunk, nothing frozen" (66.8% saving instead of 79.5%).
3. **Session key** (`src/core/session-state.ts`) hangs on the first user
   message's hash. 37,415 POST requests shared 30 keys on this host (the
   largest: 2.2 days, three models, 56% overlap). The `freezeStep` floor
   only rises and leaks from long into short conversations; the same key
   choice distorts the dashboard baseline. **Addressed upstream in 0.14.0**
   (#293, the anchor skips `<system-reminder>` envelopes; #295 persists the
   floor across restarts), so this branch has it by its base.

Cause 2 is still open. Do not expect this branch to restore the
pre-sync figure; the honest expectation is the byte-cliff share back, minus
whatever your own traffic mix does.

## Check it on your own host

`~/.pxpipe/events.jsonl` (rotates to `.1`). Share of refusals per model,
POST `/v1/messages` only:

```python
import json, collections
c = collections.Counter()
for f in ('events.jsonl', 'events.jsonl.1'):
    try:
        for line in open(f'/root/.pxpipe/{f}'):
            try: e = json.loads(line)
            except Exception: continue
            if e.get('path') != '/v1/messages' or not e.get('history_reason'): continue
            c[(e.get('model'), e['history_reason'])] += 1
    except FileNotFoundError: pass
for (m, r), n in sorted(c.items()): print(f'{n:7d} {m} {r}')
```

Before the fix, `image_bytes` dominating on Opus is the cliff. After it,
`image_bytes` should be rare and `history_byte_trimmed` present on the long
sessions; count `status == 413` as well, it should stay at zero. Read the
effect on a window that starts at the restart timestamp, do not mix it with
requests served by the old build.

## Rollback

The service only reads `dist/`. Keep a copy of the old `dist/node.js`,
swap it back and restart; no git operation needed.

## Status of this branch

Rebased onto `v0.14.0` from a fork that was on 0.13.2. Five commits:
byte trim, its perf fix, this note, the PNG filter, the page count. Change
set of the history and PNG code identical to what runs on the host above
since 2026-10-03T19:06Z (there on top of a few unrelated fork commits).
The effect of the last two commits on live traffic had not been read at the
time of writing.
