import "server-only";
import { getDb } from "./db";
import { getSetting } from "./settings";
import { parseBlocks } from "./blocks";
import { now } from "./util";
import {
  dayOf,
  MAX_DWELL_PER_VISIT_MS,
  readablePassages,
  scorePassage,
  type Passage,
  type ReadingRow,
} from "./reading-score";

/**
 * Reading signals, stored and queried. The scoring itself is pure and lives
 * in ./reading-score so it can be tested without a database — the same split
 * as sync/sync-io.
 */

export * from "./reading-score";

/** Whether the instance collects reading signals at all. Default on: the
 *  data is anonymous by construction, and a switch nobody can find is not a
 *  real choice either way. Admins turn it off in one click. */
export function readingEnabled(): boolean {
  return getSetting("reading_signals") !== "off";
}

export function retentionDays(): number {
  const raw = Number(getSetting("reading_retention_days") ?? 90);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 3650) : 90;
}

/** Signals for one page, summed across every day retained. */
export function signalsForPage(pageId: string): Map<string, ReadingRow> {
  const rows = getDb()
    .prepare(
      `SELECT block_id,
              SUM(views)    AS views,
              SUM(dwell_ms) AS dwell_ms,
              SUM(revisits) AS revisits,
              SUM(exits)    AS exits
         FROM reading_signals
        WHERE page_id = ?
        GROUP BY block_id`
    )
    .all(pageId) as ReadingRow[];
  return new Map(rows.map((r) => [r.block_id, r]));
}

/** The whole page, in document order, scored. */
export function readingReport(pageId: string, content: string): Passage[] {
  const signals = signalsForPage(pageId);
  return readablePassages(parseBlocks(content)).map(({ id, text }) => {
    const s = signals.get(id);
    const scored = scorePassage({
      text,
      views: s?.views ?? 0,
      dwellMs: s?.dwell_ms ?? 0,
      revisits: s?.revisits ?? 0,
      exits: s?.exits ?? 0,
    });
    return { ...scored, blockId: id };
  });
}

/**
 * Record one reader's visit. Values are clamped here rather than trusted:
 * this endpoint is reachable by anyone who can read the page, which on a
 * public space means anyone at all.
 */
export function recordReading(
  pageId: string,
  entries: { id: string; dwell: number; revisits: number; exit: boolean }[],
  validBlockIds: Set<string>
): number {
  if (!readingEnabled()) return 0;
  const db = getDb();
  const day = dayOf(now());
  const stmt = db.prepare(
    `INSERT INTO reading_signals (page_id, block_id, day, views, dwell_ms, revisits, exits)
     VALUES (?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(page_id, block_id, day) DO UPDATE SET
       views    = views    + 1,
       dwell_ms = dwell_ms + excluded.dwell_ms,
       revisits = revisits + excluded.revisits,
       exits    = exits    + excluded.exits`
  );
  // Retention enforced here rather than by a scheduler: this is the only
  // code that runs when signals exist, and once a day is often enough. A
  // retention policy that depends on a cron nobody set up is a promise, not
  // a mechanism.
  pruneIfNewDay(day);

  let written = 0;
  db.transaction(() => {
    for (const e of entries.slice(0, 400)) {
      // A block id the page does not contain is either a stale client or
      // someone typing into curl. Either way it is not a reading signal.
      if (!validBlockIds.has(e.id)) continue;
      const dwell = clampInt(e.dwell, 0, MAX_DWELL_PER_VISIT_MS);
      const revisits = clampInt(e.revisits, 0, 50);
      if (dwell === 0 && revisits === 0 && !e.exit) continue;
      stmt.run(pageId, e.id, day, dwell, revisits, e.exit ? 1 : 0);
      written++;
    }
  })();
  return written;
}

function clampInt(n: unknown, lo: number, hi: number): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/** Run the prune at most once per day, on whoever happens to arrive first. */
function pruneIfNewDay(day: number): void {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM kv WHERE key = 'reading:pruned_day'")
    .get() as { value: string } | undefined;
  if (Number(row?.value ?? 0) === day) return;
  db.prepare(
    `INSERT INTO kv (key, value) VALUES ('reading:pruned_day', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(day));
  pruneReading();
}

/** Drop signals past the retention window. Cheap; safe to call often. */
export function pruneReading(): number {
  const cutoff = dayOf(now()) - retentionDays() * 86_400_000;
  return getDb().prepare("DELETE FROM reading_signals WHERE day < ?").run(cutoff)
    .changes;
}

/** Everything for one page, forgotten. Used when signals are turned off. */
export function forgetAllReading(): number {
  return getDb().prepare("DELETE FROM reading_signals").run().changes;
}
