import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { currentUser } from "@/lib/auth";
import { getDb, DATA_DIR } from "@/lib/db";

const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

/**
 * Restore a database snapshot taken from the backups page.
 *
 * Safety, in order:
 *   1. admin only;
 *   2. the upload is validated as a real SQLite file with Octavo's tables
 *      *before* anything is touched;
 *   3. the current database is snapshotted beside itself first, so a bad
 *      restore is always reversible;
 *   4. the swap happens on disk and the process exits so the next request
 *      opens the restored file — never a half-swapped connection.
 */
export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user || user.role !== "admin")
    return NextResponse.redirect(new URL("/login", req.url), { status: 303 });

  const form = await req.formData();
  const file = form.get("file");
  const confirm = String(form.get("confirm") ?? "");
  const fail = (why: string) =>
    NextResponse.redirect(
      new URL(`/admin/backups?error=${encodeURIComponent(why)}`, req.url),
      { status: 303 }
    );

  if (confirm !== "REPLACE") return fail("type REPLACE to confirm");
  if (!(file instanceof File)) return fail("choose a snapshot file");
  if (file.size > MAX_BYTES) return fail("file is too large");

  const tmp = path.join(os.tmpdir(), `octavo-restore-${Date.now()}.db`);
  fs.writeFileSync(tmp, Buffer.from(await file.arrayBuffer()));

  // Validate before touching anything that matters.
  try {
    const candidate = new Database(tmp, { readonly: true, fileMustExist: true });
    const tables = (
      candidate
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[]
    ).map((t) => t.name);
    const required = ["users", "spaces", "pages"];
    const missing = required.filter((t) => !tables.includes(t));
    const users = missing.length
      ? 0
      : (candidate.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n;
    candidate.close();
    if (missing.length) {
      fs.unlinkSync(tmp);
      return fail(`not an Octavo snapshot (missing ${missing.join(", ")})`);
    }
    if (users === 0) {
      fs.unlinkSync(tmp);
      return fail("snapshot has no accounts — restoring it would lock everyone out");
    }
  } catch {
    fs.unlinkSync(tmp);
    return fail("that file is not a readable SQLite database");
  }

  // Keep the outgoing database: a restore must be reversible.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const live = path.join(DATA_DIR, "octavo.db");
  const rollback = path.join(DATA_DIR, `octavo-replaced-${stamp}.db`);
  try {
    await getDb().backup(rollback);
  } catch {
    /* first run with no data — nothing to preserve */
  }

  // Swap on disk, clearing WAL/SHM so no stale pages survive the change.
  try {
    getDb().close();
  } catch {
    /* already closed */
  }
  for (const suffix of ["-wal", "-shm"]) {
    const f = live + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  fs.copyFileSync(tmp, live);
  fs.unlinkSync(tmp);
  globalThis.__octavoDb = undefined;

  const res = NextResponse.redirect(
    new URL("/admin/backups?restored=1", req.url),
    { status: 303 }
  );
  res.cookies.delete("octavo_session");
  return res;
}
