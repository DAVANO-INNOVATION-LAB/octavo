import type { Block } from "./blocks";

/**
 * Where readers stumble.
 *
 * A documentation tool is written by the person who least needs it. The
 * author knows the thing, so the author cannot see which sentence fails —
 * that is the curse of knowledge, and no amount of care escapes it. The only
 * way to find the bad sentence is to watch what happens when someone meets
 * it.
 *
 * So this module measures reading, not readers. Three behaviours, per
 * passage:
 *
 *   dwell     how long the passage stayed on screen, against how long it
 *             should take to read
 *   revisits  how often someone scrolled back to it — the strongest signal
 *             there is, because re-reading is not an opinion
 *   exits     how often it was the last thing on screen before the reader
 *             gave up
 *
 * None of it is attributed. See the table definition: there is no user id to
 * join against, so "did Sarah read the handbook" is not a question this
 * schema can answer. That is deliberate and it is the condition on which a
 * feature like this is decent at all.
 */

/** Words a minute for prose. Deliberately generous — we want to flag the
 *  passages that take much longer than reading, not merely longer. */
const WPM = 220;

/** One reader cannot contribute more than this to a passage in one visit.
 *  Someone leaving a tab open overnight is not a stumble. */
export const MAX_DWELL_PER_VISIT_MS = 120_000;

/** Below this many views a score is noise, and showing it invites nonsense. */
export const MIN_VIEWS = 5;

/** Below this many words a passage is a heading, a divider, or a caption.
 *  Those are worth showing in the page scan but not worth *ranking*: a rule
 *  of dashes cannot be rewritten more clearly, and putting one at the top of
 *  a writer's list teaches them to distrust the list. */
export const MIN_RANKABLE_WORDS = 8;

/** Whether a passage is prose someone could actually rewrite. */
export function isRankable(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < MIN_RANKABLE_WORDS) return false;
  // Mostly punctuation is a separator wearing a sentence's word count.
  const letters = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return letters / text.length > 0.6;
}

export type ReadingRow = {
  block_id: string;
  views: number;
  dwell_ms: number;
  revisits: number;
  exits: number;
};

export type Passage = {
  blockId: string;
  /** The passage itself, trimmed, so a writer recognises what they wrote. */
  text: string;
  words: number;
  views: number;
  /** Mean time on screen per view. */
  dwellPerView: number;
  /** How long reading it should take. */
  expectedMs: number;
  /** dwellPerView / expectedMs. 1.0 is exactly reading pace. */
  slowdown: number;
  revisitRate: number;
  exitRate: number;
  /** 0..1. Higher means more readers had trouble here. */
  score: number;
  enough: boolean;
};

/** Midnight UTC for a timestamp — the bucket signals are summed into. */
export function dayOf(ms: number): number {
  return Math.floor(ms / 86_400_000) * 86_400_000;
}

/** Flatten a document to the passages a reader actually sees as units. */
export function readablePassages(blocks: Block[]): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  const walk = (list: Block[]) => {
    for (const b of list) {
      const text = plainText(b);
      if (text) out.push({ id: b.id, text });
      if (b.children?.length) walk(b.children);
    }
  };
  walk(blocks);
  return out;
}

function plainText(b: Block): string {
  const content = (b as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" ? String((c as { text?: string }).text ?? "") : ""))
    .join("")
    .trim();
}

function countWords(text: string): number {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

/**
 * Turn counters into a score.
 *
 * Weighted so that re-reading dominates: a reader who scrolls back has told
 * you something a reader who lingers has not. Dwell alone is the weakest of
 * the three — a person can be slow because they were interrupted — so it is
 * capped and given the least weight.
 */
export function scorePassage(input: {
  text: string;
  views: number;
  dwellMs: number;
  revisits: number;
  exits: number;
}): Passage & { blockId: string } {
  const words = countWords(input.text);
  const views = Math.max(0, input.views);
  const expectedMs = Math.max(1200, (words / WPM) * 60_000);
  const dwellPerView = views > 0 ? input.dwellMs / views : 0;
  const slowdown = dwellPerView / expectedMs;
  const revisitRate = views > 0 ? input.revisits / views : 0;
  const exitRate = views > 0 ? input.exits / views : 0;

  // Each term is squashed into 0..1 before weighting so one wild number
  // cannot swamp the other two.
  const slowTerm = clamp01((slowdown - 1) / 3);
  const revisitTerm = clamp01(revisitRate / 0.4);
  const exitTerm = clamp01(exitRate / 0.3);

  const score = clamp01(0.25 * slowTerm + 0.5 * revisitTerm + 0.25 * exitTerm);

  return {
    blockId: "",
    text: input.text,
    words,
    views,
    dwellPerView,
    expectedMs,
    slowdown,
    revisitRate,
    exitRate,
    score,
    enough: views >= MIN_VIEWS,
  };
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
