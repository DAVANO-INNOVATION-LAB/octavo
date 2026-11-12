import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

export class RestoreError extends Error {}

/** Check every SQLite page, not just the schema and the accounts table. */
export function validateSnapshot(filename: string): void {
  let db: Database.Database | undefined;
  try {
    db = new Database(filename, { readonly: true, fileMustExist: true });
    const integrity = db.pragma("integrity_check") as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok")
      throw new RestoreError("snapshot failed SQLite integrity validation");
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(t => t.name);
    const missing = ["users", "spaces", "pages"].filter(t => !tables.includes(t));
    if (missing.length) throw new RestoreError(`not an Octavo snapshot (missing ${missing.join(", ")})`);
    if (!(db.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n)
      throw new RestoreError("snapshot has no accounts — restoring it would lock everyone out");
  } catch (error) {
    if (error instanceof RestoreError) throw error;
    throw new RestoreError("that file is not a readable SQLite database");
  } finally {
    db?.close();
  }
}

function syncFile(filename: string): void {
  const fd = fs.openSync(filename, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/**
 * Single-writer deployment only: stop other processes using this database first.
 * No await is allowed here: backup, checkpoint, close and rename must not yield
 * to another request that could write to the outgoing database.
 */
export function restoreSnapshot(bytes: Buffer, dataDir: string, getDb: () => Database.Database, resetDb: () => void): void {
  const stage = fs.mkdtempSync(path.join(dataDir, ".octavo-restore-"));
  const candidate = path.join(stage, "candidate.db");
  const backup = path.join(stage, "rollback.db");
  const live = path.join(dataDir, "octavo.db");
  try {
    fs.writeFileSync(candidate, bytes, { flag: "wx", mode: 0o600 });
    validateSnapshot(candidate);
    syncFile(candidate);

    // VACUUM INTO is a synchronous, consistent SQLite snapshot including WAL.
    // Any backup/validation/fsync/rename failure aborts before closing live DB.
    const db = getDb();
    db.prepare("VACUUM INTO ?").run(backup);
    fs.chmodSync(backup, 0o600);
    validateSnapshot(backup);
    syncFile(backup);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.renameSync(backup, path.join(dataDir, `octavo-replaced-${stamp}-${randomUUID()}.db`));
    // Persist the rollback directory entry before changing the live file.
    syncFile(dataDir);

    // Do not delete WAL files: a failed checkpoint must leave all live data intact.
    const checkpoint = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
    if (checkpoint.some(row => row.busy !== 0)) throw new RestoreError("database is busy; restore was not applied");
    db.close();
    resetDb();
    // Normally close removes these. Refuse a nonempty WAL from another writer.
    if (fs.existsSync(live + "-wal") && fs.statSync(live + "-wal").size !== 0)
      throw new RestoreError("database is in use; stop other writers before restoring");
    // Same filesystem, atomic replacement: a failed rename leaves live untouched.
    fs.renameSync(candidate, live);
  } finally {
    try { fs.rmSync(stage, { recursive: true, force: true }); }
    catch (error) { console.error("Could not remove restore staging directory", error); }
  }
}
