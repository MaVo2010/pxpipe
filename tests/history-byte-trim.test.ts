/**
 * A history too heavy for the byte budget is collapsed IN PART, oldest first.
 *
 * Before this, the collapse was rendered whole and then admitted or refused as one
 * group. Refusing was the wrong half of that trade on long sessions: measured on
 * production traffic (2026-09-12 … 09-29, 5,753 refusals, 99.7% Opus) a refused
 * request kept its ENTIRE history as text, so the sessions that cost the most were
 * the ones that stopped being compressed at all — and they still paid for the full
 * render (p50 1.8 s, p90 8.2 s) before throwing it away.
 *
 * The properties pinned here, in the order they matter:
 *
 *  - the oldest turns are imaged and the rest stays live text, verbatim;
 *  - the cut is a closed boundary, so no tool_result is separated from its call;
 *  - the cut does not move as the conversation grows, because a moving cut re-keys
 *    everything behind it and the text tail behind it is large;
 *  - a coarse grid is no excuse: 44% of the measured refusals sat at a freeze step
 *    of 160 or more, where the range is one chunk and "cut at a chunk end" is zero.
 *
 * Run just this file:  pnpm vitest run tests/history-byte-trim.test.ts
 */
import { describe, expect, it } from 'vitest';
import { collapseHistory, findClosedPrefixBoundary } from '../src/core/history.js';
import { clearRenderCache, renderCacheStats } from '../src/core/render.js';
import type { Message } from '../src/core/types.js';

const WORDS = [
  'order', 'window', 'latency', 'buffer', 'ledger', 'margin', 'signal', 'replay',
  'socket', 'cursor', 'bucket', 'stream', 'anchor', 'digest', 'format', 'kernel',
  'packet', 'review', 'series', 'thread', 'update', 'vector', 'worker', 'zone',
  'because', 'therefore', 'measured', 'against', 'before', 'after', 'never', 'always',
];

/** Deterministic filler that differs per seed. A run of one repeated character
 *  compresses to almost nothing, which would make every page weigh the same and
 *  the byte budget meaningless; real words make PNG weight follow the content. */
function prose(seed: number, chars: number): string {
  let s = (Math.imul(seed + 1, 2654435761) + 12345) >>> 0;
  const out: string[] = [];
  let len = 0;
  while (len < chars) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const w = WORDS[s % WORDS.length]! + (s % 7 === 0 ? ` ${s % 9973}` : '');
    out.push(w);
    len += w.length + 1;
  }
  return out.join(' ').slice(0, chars);
}

const asst = (content: Message['content']): Message => ({ role: 'assistant', content });
const usr = (content: Message['content']): Message => ({ role: 'user', content });

/** Short prompt, long answer. Every message boundary is a closed boundary. */
function plainConvo(messages: number, chars = 1500): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages; i++) {
    out.push(i % 2 === 0 ? usr(`question ${i}`) : asst(`answer ${i}: ` + prose(i, chars)));
  }
  return out;
}

function toolCall(i: number): Message {
  return asst([
    { type: 'text', text: `reading file ${i}` },
    { type: 'tool_use', id: `tu${i}`, name: 'Read', input: { path: `/f/${i}` } },
  ] as Message['content']);
}
function toolResult(i: number, chars: number): Message {
  return usr([
    { type: 'tool_result', tool_use_id: `tu${i}`, content: `RESULT ${i}\n` + prose(i, chars) },
  ] as Message['content']);
}

type Block = { type: string; source?: { data: string } };
const imagesOf = (m: Message | undefined): string[] =>
  Array.isArray(m?.content)
    ? (m!.content as unknown as Block[])
        .filter((b) => b.type === 'image')
        .map((b) => b.source!.data)
    : [];

const always = () => true;
/** Count budget off, so every case below isolates the byte budget. */
const BASE = { imageBudget: 0 } as const;

describe('a history over the byte budget is collapsed in part', () => {
  it('images the oldest turns and leaves the rest as live text, verbatim', async () => {
    const msgs = plainConvo(124);
    const full = await collapseHistory(msgs, always, BASE);
    expect(full.info.collapsedTurns).toBe(100);

    const byteBudget = Math.floor(full.info.collapsedImageBytes / 2);
    const { messages: out, info } = await collapseHistory(msgs, always, { ...BASE, byteBudget });

    expect(info.reason).toBeUndefined();
    expect(info.byteTrimmed).toBe(true);
    expect(info.collapsedTurns).toBeGreaterThan(0);
    expect(info.collapsedTurns).toBeLessThan(full.info.collapsedTurns);
    expect(info.collapsedImageBytes).toBeLessThanOrEqual(byteBudget);
    // The budget is spent, not gestured at: at a 10-message grid the unused
    // remainder is less than one chunk, which here is a fifth of the budget.
    expect(info.collapsedImageBytes).toBeGreaterThan(byteBudget * 0.75);
    // What the telemetry reports is what the message carries.
    expect(imagesOf(out[0])).toHaveLength(info.collapsedImages);
    // Degrading never drops content: every turn past the cut is the original
    // object, in order.
    const tail = out.slice(1);
    expect(tail).toHaveLength(msgs.length - info.collapsedTurns);
    tail.forEach((m, k) => expect(m).toBe(msgs[info.collapsedTurns + k]));
  });

  it('descends into a single coarse chunk instead of giving up', async () => {
    const msgs = plainConvo(124);
    // A session already repacked coarse: the whole range is one chunk, so there
    // is no chunk end to cut at short of the start.
    const coarse = { ...BASE, minFreezeStep: 1280 };
    const full = await collapseHistory(msgs, always, coarse);
    expect(full.info.freezeStep).toBeGreaterThanOrEqual(100);

    const byteBudget = Math.floor(full.info.collapsedImageBytes / 2);
    const { info } = await collapseHistory(msgs, always, { ...coarse, byteBudget });

    expect(info.reason).toBeUndefined();
    expect(info.byteTrimmed).toBe(true);
    expect(info.collapsedImageBytes).toBeLessThanOrEqual(byteBudget);
    expect(info.collapsedImageBytes).toBeGreaterThan(byteBudget * 0.6);
  });

  it('uses the room it is given inside a coarse chunk', async () => {
    // The descent is a search, not one halving: with more room, more of the same
    // chunk goes into the pixels.
    const msgs = plainConvo(124);
    const coarse = { ...BASE, minFreezeStep: 1280 };
    const full = await collapseHistory(msgs, always, coarse);
    const at = (share: number) =>
      collapseHistory(msgs, always, {
        ...coarse,
        byteBudget: Math.floor(full.info.collapsedImageBytes * share),
      });
    const tight = await at(0.45);
    const roomy = await at(0.75);

    expect(tight.info.collapsedTurns).toBeGreaterThan(0);
    expect(roomy.info.collapsedTurns).toBeGreaterThan(tight.info.collapsedTurns);
  });

  it('reports the freeze step of the grid, not of the descent', async () => {
    // The caller pins this value per session as a floor. Reporting a finer step
    // from the descent would be harmless (the floor only rises); reporting a
    // COARSER one would re-cut a session that did nothing to deserve it.
    const msgs = plainConvo(124);
    const full = await collapseHistory(msgs, always, BASE);
    const byteBudget = Math.floor(full.info.collapsedImageBytes / 2);
    const { info } = await collapseHistory(msgs, always, { ...BASE, byteBudget });
    expect(info.freezeStep).toBe(full.info.freezeStep);
  });
});

describe('the cut holds still', () => {
  it('stays where it is as the conversation grows, with byte-identical pages', async () => {
    const msgs = plainConvo(224);
    const probe = await collapseHistory(msgs.slice(0, 124), always, BASE);
    const byteBudget = Math.floor(probe.info.collapsedImageBytes / 2);

    const early = await collapseHistory(msgs.slice(0, 124), always, { ...BASE, byteBudget });
    const later = await collapseHistory(msgs.slice(0, 174), always, { ...BASE, byteBudget });
    const last = await collapseHistory(msgs, always, { ...BASE, byteBudget });

    expect(early.info.byteTrimmed).toBe(true);
    expect(later.info.collapsedTurns).toBe(early.info.collapsedTurns);
    expect(last.info.collapsedTurns).toBe(early.info.collapsedTurns);
    // Same bytes, not merely the same count: this is what the prompt cache keys on.
    expect(imagesOf(later.messages[0])).toEqual(imagesOf(early.messages[0]));
    expect(imagesOf(last.messages[0])).toEqual(imagesOf(early.messages[0]));
  });

  it('keeps the pages it shares with the untrimmed render byte-identical', async () => {
    // A session crosses the budget mid-life. The pages it had already paid to
    // cache must survive that turn, or the first trimmed request re-keys the lot.
    const msgs = plainConvo(124);
    const full = await collapseHistory(msgs, always, BASE);
    const byteBudget = Math.floor(full.info.collapsedImageBytes / 2);
    const cut = await collapseHistory(msgs, always, { ...BASE, byteBudget });

    const before = imagesOf(full.messages[0]);
    const after = imagesOf(cut.messages[0]);
    // Whole chunks only, so the trimmed render is a strict prefix of the full one.
    expect(cut.info.collapsedTurns % 10).toBe(0);
    expect(after.length).toBeGreaterThan(0);
    expect(after).toEqual(before.slice(0, after.length));
  });
});

describe('the cut is a closed boundary', () => {
  it('falls back behind a run of tool rounds rather than splitting it', async () => {
    // 40 plain messages, then one unbroken run of 30 tool rounds, then plain
    // text again. Consecutive rounds count as ONE round, so the only closed
    // boundaries near the run are its two ends.
    const msgs: Message[] = plainConvo(40);
    for (let i = 0; i < 30; i++) msgs.push(toolCall(i), toolResult(i, 1500));
    msgs.push(...plainConvo(24).map((m, k) => (k % 2 === 0 ? asst(`note ${k}`) : usr(`next ${k}`))));

    const full = await collapseHistory(msgs, always, BASE);
    expect(full.info.collapsedTurns).toBe(100);
    // Enough for the plain opening and part of the run, not for all of it.
    const byteBudget = Math.floor(full.info.collapsedImageBytes * 0.6);
    const { messages: out, info } = await collapseHistory(msgs, always, { ...BASE, byteBudget });

    expect(info.reason).toBeUndefined();
    expect(info.byteTrimmed).toBe(true);
    expect(info.collapsedImageBytes).toBeLessThanOrEqual(byteBudget);
    const cut = info.collapsedTurns;
    expect(cut).toBeGreaterThan(0);
    // The definition of a legal cut, asked of the function that defines it.
    expect(findClosedPrefixBoundary(msgs, cut)).toBe(cut - 1);
    // And the consequence that matters on the wire: the live text does not
    // open with a result whose call went into the pixels.
    expect(cut).toBeLessThanOrEqual(40);
    expect(out[1]).toBe(msgs[cut]);

    // The budget ran out two chunks into the run. Moving the cut back has to
    // take those chunks out of the pixels as well, or they are sent twice: once
    // as pages and once as the live text behind the cut. A budget that ends at
    // the same boundary on its own is the reference.
    const natural = await collapseHistory(msgs, always, {
      ...BASE,
      byteBudget: Math.floor(full.info.collapsedImageBytes * 0.45),
    });
    expect(natural.info.collapsedTurns).toBe(cut);
    expect(imagesOf(out[0])).toEqual(imagesOf(natural.messages[0]));
    expect(info.collapsedImageBytes).toBe(natural.info.collapsedImageBytes);
  });
});

describe('when trimming cannot help', () => {
  it('keeps the whole history as text if not even the minimum fits', async () => {
    const msgs = plainConvo(124);
    const { messages: out, info } = await collapseHistory(msgs, always, { ...BASE, byteBudget: 1 });

    expect(out).toBe(msgs);
    expect(info.reason).toBe('image_bytes');
    // A refusal reports nothing spent, so no caller can book pages that are not
    // on the wire.
    expect(info.collapsedTurns).toBe(0);
    expect(info.collapsedImages).toBe(0);
    expect(info.collapsedImageBytes).toBe(0);
    expect(info.collapsedPngs).toHaveLength(0);
    expect(info.collapsedImageDims).toHaveLength(0);
  });

  it('keeps the whole history as text if what fits is less than the minimum', async () => {
    // Something fits here, unlike above: one chunk of ten messages. That is not
    // enough to be worth a synthetic message when the caller asks for thirty.
    const msgs = plainConvo(124);
    const full = await collapseHistory(msgs, always, BASE);
    const byteBudget = Math.floor(full.info.collapsedImageBytes * 0.15);
    const some = await collapseHistory(msgs, always, { ...BASE, byteBudget });
    expect(some.info.collapsedTurns).toBe(10);

    const { messages: out, info } = await collapseHistory(msgs, always, {
      ...BASE,
      byteBudget,
      minCollapsePrefix: 30,
    });
    expect(out).toBe(msgs);
    expect(info.reason).toBe('image_bytes');
    expect(info.collapsedTurns).toBe(0);
    expect(info.collapsedImageBytes).toBe(0);
    expect(info.collapsedPngs).toHaveLength(0);
  });

  it('treats a budget of zero as no room, not as no limit', async () => {
    const msgs = plainConvo(124);
    const { messages: out, info } = await collapseHistory(msgs, always, { ...BASE, byteBudget: 0 });
    expect(out).toBe(msgs);
    expect(info.reason).toBe('image_bytes');
  });

  it('answers a budget of zero without rendering anything', async () => {
    // A session that sits at the ceiling asks on every request. Hits count as
    // well as misses: a page served from the cache is still a page asked for.
    const msgs = plainConvo(124);
    const asked = (): number => renderCacheStats().hits + renderCacheStats().misses;

    // The premise: a refusal that has to look does show up in this counter.
    clearRenderCache();
    await collapseHistory(msgs, always, { ...BASE, byteBudget: 1 });
    expect(asked()).toBeGreaterThan(0);

    clearRenderCache();
    await collapseHistory(msgs, always, { ...BASE, byteBudget: 0 });
    expect(asked()).toBe(0);
  });

  it('asks the profitability gate about the text it will actually image', async () => {
    const msgs = plainConvo(124);
    const seen: number[] = [];
    const full = await collapseHistory(
      msgs,
      (t) => {
        seen.push(t.length);
        return true;
      },
      BASE,
    );
    const fullLen = seen[0]!;
    // Profitable at full length, not at the half the budget leaves.
    const gate = (t: string): boolean => t.length > fullLen * 0.8;
    const byteBudget = Math.floor(full.info.collapsedImageBytes / 2);
    const { messages: out, info } = await collapseHistory(msgs, gate, { ...BASE, byteBudget });

    expect(out).toBe(msgs);
    expect(info.reason).toBe('not_profitable');
    expect(info.collapsedTurns).toBe(0);
    expect(info.collapsedImageBytes).toBe(0);
  });
});

describe('the count cap still holds while trimming by weight', () => {
  it('never emits more images than the image budget', async () => {
    // Many small turns: one page holds several 10-message chunks, so every level
    // of the descent ends on a partly filled page and the count grows faster
    // than the bytes do.
    const msgs = plainConvo(324, 300);
    const packed = await collapseHistory(msgs, always, { imageBudget: 0, minFreezeStep: 1280 });
    const imageBudget = packed.info.collapsedImages;
    const byteBudget = packed.info.collapsedImageBytes - 1;

    const { info } = await collapseHistory(msgs, always, { imageBudget, byteBudget });

    expect(info.reason).toBeUndefined();
    expect(info.byteTrimmed).toBe(true);
    expect(info.collapsedImages).toBeLessThanOrEqual(imageBudget);
    expect(info.collapsedImageBytes).toBeLessThanOrEqual(byteBudget);
  });
});

describe('a history inside the budget is left alone', () => {
  it('renders exactly what it rendered without a budget', async () => {
    const msgs = plainConvo(124);
    const free = await collapseHistory(msgs, always, BASE);
    const roomy = await collapseHistory(msgs, always, {
      ...BASE,
      byteBudget: free.info.collapsedImageBytes,
    });
    expect(roomy.info.byteTrimmed).toBeUndefined();
    expect(roomy.info.collapsedTurns).toBe(free.info.collapsedTurns);
    expect(imagesOf(roomy.messages[0])).toEqual(imagesOf(free.messages[0]));
  });
});

/** PNG bytes the render cache holds. Straight after clearRenderCache() that is
 *  every page the call had rendered, admitted or thrown away — which makes it the
 *  work done, in the same unit as the budget. */
const rendered = (): number => renderCacheStats().bytes;

/** A session already repacked coarse: the whole range is one chunk. */
const COARSE = { ...BASE, minFreezeStep: 1280 } as const;

describe('the work follows the budget, not the session', () => {
  // Measured on the first build of the partial collapse (side port, 2026-09-29): a
  // coarse session four times over the budget rendered the whole range, then each
  // half of it on the way down — 160 MiB of pages to admit 17, 24 s per request,
  // and more than the render cache holds, so every request paid it again.
  it('does not render a coarse chunk it cannot admit', async () => {
    const msgs = plainConvo(624);

    clearRenderCache();
    const full = await collapseHistory(msgs, always, COARSE);
    expect(full.info.freezeStep).toBeGreaterThanOrEqual(600);
    // The premise: a render does show up in this counter, at its weight.
    expect(rendered()).toBeGreaterThanOrEqual(full.info.collapsedImageBytes);
    const chunk = full.info.collapsedImageBytes / (full.info.collapsedTurns / 10);

    for (const share of [1 / 4, 1 / 8]) {
      const byteBudget = Math.floor(full.info.collapsedImageBytes * share);
      clearRenderCache();
      const { info } = await collapseHistory(msgs, always, { ...COARSE, byteBudget });

      expect(info.byteTrimmed).toBe(true);
      expect(info.collapsedImageBytes).toBeLessThanOrEqual(byteBudget);
      // Sparing renders is not an excuse to leave room unused.
      expect(info.collapsedImageBytes).toBeGreaterThan(byteBudget * 0.85);
      // What may still be rendered in vain is a chunk that could not be told from
      // one that fits: at most the slack times the room left. Its first half then
      // fits, so the next such chunk is a quarter of it, and so on — 1.5 × 4/3,
      // twice the budget in all. Add what is admitted, and the probe: a page's
      // worth in base chunks, two of them here.
      expect(rendered()).toBeLessThan(3 * byteBudget + 2 * chunk);
    }
  }, 60_000);

  it('costs a coarse history inside the budget no more than a probe', async () => {
    const msgs = plainConvo(624);
    clearRenderCache();
    const full = await collapseHistory(msgs, always, COARSE);
    const whole = rendered();

    clearRenderCache();
    const roomy = await collapseHistory(msgs, always, {
      ...COARSE,
      byteBudget: full.info.collapsedImageBytes,
    });

    expect(roomy.info.byteTrimmed).toBeUndefined();
    expect(imagesOf(roomy.messages[0])).toEqual(imagesOf(full.messages[0]));
    expect(rendered()).toBeLessThan(whole * 1.15);
  }, 60_000);

  it('renders nothing on a fine grid beyond the chunk that did not fit', async () => {
    const msgs = plainConvo(624);
    const full = await collapseHistory(msgs, always, BASE);
    const chunk = full.info.collapsedImageBytes / (full.info.collapsedTurns / 10);
    const byteBudget = Math.floor(full.info.collapsedImageBytes / 4);

    clearRenderCache();
    const { info } = await collapseHistory(msgs, always, { ...BASE, byteBudget });

    expect(info.byteTrimmed).toBe(true);
    expect(rendered()).toBeLessThan(info.collapsedImageBytes + 2 * chunk);
  }, 60_000);

  it('holds the cut still on a coarse grid as the conversation grows', async () => {
    const msgs = plainConvo(924);
    const probe = await collapseHistory(msgs.slice(0, 624), always, COARSE);
    const byteBudget = Math.floor(probe.info.collapsedImageBytes / 4);

    const early = await collapseHistory(msgs.slice(0, 624), always, { ...COARSE, byteBudget });
    const later = await collapseHistory(msgs, always, { ...COARSE, byteBudget });

    expect(early.info.byteTrimmed).toBe(true);
    expect(later.info.collapsedTurns).toBe(early.info.collapsedTurns);
    expect(imagesOf(later.messages[0])).toEqual(imagesOf(early.messages[0]));
  }, 60_000);

  it('weighs nothing in advance when there is no budget to keep', async () => {
    const msgs = plainConvo(624);
    clearRenderCache();
    const { info } = await collapseHistory(msgs, always, COARSE);

    expect(info.byteTrimmed).toBeUndefined();
    expect(info.freezeStep).toBeGreaterThanOrEqual(info.collapsedTurns);
    // One chunk, one render. A probe is a question about a budget.
    expect(renderCacheStats().misses).toBe(1);
  }, 60_000);

  it('measures a chunk against the room left, not the room it started with', async () => {
    const msgs = plainConvo(624);
    // What the descent admits first: the front half of the cell the range lies in.
    // (The cutoff snaps to collapseChunk, 50 by default; 320 is not on that grid.)
    const front = (
      await collapseHistory(msgs.slice(0, 324), always, { ...COARSE, collapseChunk: 10 })
    ).info;
    expect(front.collapsedTurns).toBe(320);
    const byteBudget = Math.floor(front.collapsedImageBytes * 1.08);

    clearRenderCache();
    const { info } = await collapseHistory(msgs, always, { ...COARSE, byteBudget });

    expect(info.byteTrimmed).toBe(true);
    expect(info.collapsedTurns).toBeGreaterThanOrEqual(320);
    expect(info.collapsedImageBytes).toBeLessThanOrEqual(byteBudget);
    // With the front admitted, a thirteenth of the budget is left, and what may be
    // rendered in vain is twice that (see above). Against the whole budget the
    // next three parts of the descent would all pass for worth a try: seven
    // eighths of the front again.
    expect(rendered()).toBeLessThan(byteBudget * 1.4);
  }, 60_000);
});

/** A body whose rows repeat: it fills pages the way prose does and weighs a
 *  fraction of it, so weight per character is not one number for the session. */
const drone = (i: number, chars: number): string =>
  `${i} `.padEnd(8, '.') + 'steady '.repeat(Math.ceil(chars / 7)).slice(0, chars);

function convoOf(from: number, messages: number, body: (i: number) => string): Message[] {
  const out: Message[] = [];
  for (let i = from; i < from + messages; i++) {
    out.push(i % 2 === 0 ? usr(`question ${i}`) : asst(`answer ${i}: ` + body(i)));
  }
  return out;
}

describe('an estimate spares renders and admits nothing', () => {
  const heavy = (i: number): string => prose(i, 1500);
  const light = (i: number): string => drone(i, 1500);
  const weightOf = async (msgs: Message[]): Promise<number> =>
    (await collapseHistory([...msgs, ...plainConvo(4)], always, COARSE)).info.collapsedImageBytes;

  it('weighs a heavy stretch behind a light opening instead of trusting the opening', async () => {
    const opening = convoOf(0, 100, light);
    const msgs = [...opening, ...convoOf(100, 324, heavy)];
    const lightBytes = await weightOf(opening);
    const allBytes = (await collapseHistory(msgs, always, COARSE)).info.collapsedImageBytes;
    // The premise: the opening is the light part, by a wide margin per character.
    expect(lightBytes / 100).toBeLessThan((allBytes - lightBytes) / 320 / 3);

    const byteBudget = Math.floor(lightBytes + (allBytes - lightBytes) / 3);
    const { messages: out, info } = await collapseHistory(msgs, always, { ...COARSE, byteBudget });

    expect(info.reason).toBeUndefined();
    expect(info.byteTrimmed).toBe(true);
    // Judged by the opening, three times as much would seem to fit.
    expect(info.collapsedImageBytes).toBeLessThanOrEqual(byteBudget);
    expect(info.collapsedTurns).toBeGreaterThanOrEqual(100);
    const tail = out.slice(1);
    expect(tail).toHaveLength(msgs.length - info.collapsedTurns);
    tail.forEach((m, k) => expect(m).toBe(msgs[info.collapsedTurns + k]));
  }, 60_000);

  it('finds less, not nothing, when a light stretch follows a heavy opening', async () => {
    const opening = convoOf(0, 100, heavy);
    const msgs = [...opening, ...convoOf(100, 324, light)];
    const heavyBytes = await weightOf(opening);
    const allBytes = (await collapseHistory(msgs, always, COARSE)).info.collapsedImageBytes;
    expect((allBytes - heavyBytes) / 320).toBeLessThan(heavyBytes / 100 / 3);

    const byteBudget = Math.floor(heavyBytes * 1.2 + (allBytes - heavyBytes) / 2);
    const { info } = await collapseHistory(msgs, always, { ...COARSE, byteBudget });

    // Judged by the opening, the light stretch looks too heavy to try. That is
    // allowed to cost room. It is not allowed to cost the opening.
    expect(info.reason).toBeUndefined();
    expect(info.collapsedImageBytes).toBeLessThanOrEqual(byteBudget);
    expect(info.collapsedTurns).toBeGreaterThanOrEqual(100);
  }, 60_000);

  it('does not judge the session by its first exchange', async () => {
    // One base chunk of repeating rows, then prose. The steadiness the estimate
    // relies on was measured on stretches of a page and more, which is why the
    // probe reads that much before it is believed. (A merely terse opening is no
    // case: ten messages of a few words weigh 1.28 times the session's rate.)
    const msgs = [...convoOf(0, 10, light), ...convoOf(10, 614, heavy)];
    const first = await collapseHistory(msgs.slice(0, 14), always, {
      ...COARSE,
      collapseChunk: 10,
      minCollapsePrefix: 1,
    });
    clearRenderCache();
    const full = await collapseHistory(msgs, always, COARSE);
    const whole = renderCacheStats().bytes;
    // The premise: per character the first exchange is nothing like the session.
    const perChar = (i: { collapsedImageBytes: number; collapsedChars: number }): number =>
      i.collapsedImageBytes / i.collapsedChars;
    expect(first.info.collapsedTurns).toBe(10);
    expect(perChar(full.info) / perChar(first.info)).toBeGreaterThan(3);

    const byteBudget = Math.floor(full.info.collapsedImageBytes / 4);
    clearRenderCache();
    const { info } = await collapseHistory(msgs, always, { ...COARSE, byteBudget });

    expect(info.byteTrimmed).toBe(true);
    expect(info.collapsedImageBytes).toBeLessThanOrEqual(byteBudget);
    expect(info.collapsedImageBytes).toBeGreaterThan(byteBudget * 0.85);
    // An estimate that is off costs a wrong try: measured here, the front half,
    // twice the budget. Believed after one light chunk it costs the whole range,
    // four times the budget, which is the render all of this is there to spare.
    expect(renderCacheStats().bytes).toBeLessThan(whole + info.collapsedImageBytes);
  }, 60_000);
});
