import "server-only";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DATA_DIR } from "./db";
import { now } from "./util";
import { replicaTarget, sigv4Fetch } from "./replicate";

/**
 * Restoring the backup, on a schedule, and writing down what happened.
 *
 * Shipping a snapshot proves the upload worked. It does not prove the thing
 * in the bucket is a library — that only becomes true, or false, at restore
 * time, which is the worst possible moment to find out. So this does the
 * restore in advance, against a scratch copy that touches nothing, and keeps
 * the result where someone can see it.
 *
 * A drill that only opens the file would pass on an empty database. This one
 * asserts the restored copy still contains the shape of a library, and
 * compares its size against the live one so a snapshot that quietly shrank to
 * a fraction of the real thing is a failure rather than a success.
 */

export type DrillResult = {
  ok: boolean;
  at: number;
  /** Bytes fetched from the bucket. */
  bytes?: number;
  spaces?: number;
  pages?: number;
  /** How the restored copy compares to what is live now, as a percentage. */
  ofLive?: number;
  seconds?: number;
  error?: string;
};

const HISTORY = 20;

function logPath(): string {
  return path.join(DATA_DIR, "restore-drills.json");
}

export function drillHistory(): DrillResult[] {
  try {
    const rows = JSON.parse(fs.readFileSync(logPath(), "utf8")) as DrillResult[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export function lastDrill(): DrillResult | null {
  return drillHistory()[0] ?? null;
}

function record(r: DrillResult): DrillResult {
  const rows = [r, ...drillHistory()].slice(0, HISTORY);
  try {
    fs.writeFileSync(logPath(), JSON.stringify(rows, null, 1));
  } catch {
    // Losing the log costs the record, not the drill.
  }
  return r;
}

/**
 * Fetch the newest snapshot and prove it restores.
 *
 * Everything happens in a scratch file that is deleted whatever the outcome.
 * Nothing here touches the live database, and it cannot: the restored copy is
 * opened read-only.
 */
export async function runRestoreDrill(livePages?: number): Promise<DrillResult> {
  const started = Date.now();
  const t = replicaTarget();
  if (!t) return record({ ok: false, at: now(), error: "no backup target configured" });

  const scratch = path.join(DATA_DIR, `.drill-${process.pid}.db`);
  try {
    const res = await sigv4Fetch(t, "GET", `${t.prefix}/octavo-latest.db`);
    if (!res.ok)
      return record({ ok: false, at: now(), error: `could not fetch the snapshot: HTTP ${res.status}` });
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length === 0)
      return record({ ok: false, at: now(), error: "the snapshot is empty" });
    fs.writeFileSync(scratch, body);

    const db = new Database(scratch, { readonly: true });
    let spaces = 0;
    let pages = 0;
    try {
      const integrity = db.pragma("integrity_check", { simple: true });
      if (integrity !== "ok")
        return record({ ok: false, at: now(), bytes: body.length, error: `integrity: ${integrity}` });
      spaces = (db.prepare("SELECT COUNT(*) AS c FROM spaces").get() as { c: number }).c;
      pages = (db.prepare("SELECT COUNT(*) AS c FROM pages").get() as { c: number }).c;
      // Reading one page's content proves the tables are populated rather
      // than merely present — an empty schema passes every other check here.
      db.prepare("SELECT content FROM pages LIMIT 1").get();
    } finally {
      db.close();
    }

    const seconds = Math.round((Date.now() - started) / 100) / 10;
    if (spaces === 0 || pages === 0)
      return record({
        ok: false, at: now(), bytes: body.length, spaces, pages, seconds,
        error: "the snapshot restored but holds no library",
      });

    // A backup that came back a tenth the size of the real thing restored
    // successfully and is still a disaster.
    const ofLive =
      livePages && livePages > 0 ? Math.round((pages / livePages) * 100) : undefined;
    if (ofLive !== undefined && ofLive < 50)
      return record({
        ok: false, at: now(), bytes: body.length, spaces, pages, ofLive, seconds,
        error: `the snapshot holds ${ofLive}% of the pages that are live`,
      });

    return record({ ok: true, at: now(), bytes: body.length, spaces, pages, ofLive, seconds });
  } catch (err) {
    return record({
      ok: false,
      at: now(),
      error: err instanceof Error ? err.message : "the drill did not complete",
    });
  } finally {
    fs.rmSync(scratch, { force: true });
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Run a drill on a cadence. Daily by default: often enough that a broken
 * backup is found within a day, rare enough that it costs one download.
 */
export function scheduleRestoreDrill(livePages: () => number): void {
  if (timer) { clearInterval(timer); timer = null; }
  const hours = Number(process.env.OCTAVO_DRILL_HOURS ?? "24");
  if (!Number.isFinite(hours) || hours <= 0) return;
  if (!replicaTarget()) return;
  timer = setInterval(() => { void runRestoreDrill(livePages()); }, hours * 3600_000);
  timer.unref?.();
}
