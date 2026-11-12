import "server-only";
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
import { getDb, UPLOADS_DIR } from "./db";

type CreatedFile = { file: string; dev: number | null; ino: number | null };
const imports = new AsyncLocalStorage<CreatedFile[]>();

function cleanup(files: CreatedFile[]): unknown[] {
  const failures: unknown[] = [];
  for (const owned of files.toReversed()) {
    try {
      if (owned.dev === null || owned.ino === null)
        throw new Error("Import attachment ownership could not be verified; left untouched");
      const current = fs.lstatSync(owned.file);
      if (current.dev !== owned.dev || current.ino !== owned.ino)
        throw new Error("Import attachment changed before rollback; left untouched");
      fs.unlinkSync(owned.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push(error);
    }
  }
  return failures;
}

function failed(error: unknown, files: CreatedFile[]): never {
  const failures = cleanup(files);
  if (failures.length) {
    throw new AggregateError([error, ...failures],
      `Import failed; attachment cleanup incomplete (${failures.length} files). Operator cleanup is required.`, { cause: error });
  }
  throw error;
}

/** Write a new, uniquely named attachment. Never overwrite an existing upload.
 * Register ownership before writing, so even a partial write is rolled back.
 * Callers outside an import transaction get partial-write cleanup only.
 */
export function writeImportAttachment(name: string, data: Buffer): void {
  if (!name || name !== path.basename(name) || name === "." || name === ".." || /[\\/]/.test(name))
    throw new Error("Invalid import attachment name");
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const file = path.join(UPLOADS_DIR, name);
  const fd = fs.openSync(file, "wx");
  const files = imports.getStore() ?? [];
  const owned: CreatedFile = { file, dev: null, ino: null };
  files.push(owned);
  try {
    const stat = fs.fstatSync(fd);
    owned.dev = stat.dev;
    owned.ino = stat.ino;
    fs.writeFileSync(fd, data);
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* Preserve the original write failure. */ }
    if (!imports.getStore()) failed(error, files);
    throw error;
  }
  try { fs.closeSync(fd); }
  catch (error) {
    if (!imports.getStore()) failed(error, files);
    throw error;
  }
}

/** Attribute only files exclusively created by this import attempt. The rows
 * participate in the same SQLite transaction as content and membership.
 */
export function attributeImportAttachments(spaceId: string, userId: string): void {
  const files = imports.getStore(), db = getDb();
  if (!files || !db.inTransaction) throw new Error("Import attribution requires an active import transaction");
  if (!db.prepare("SELECT 1 FROM spaces WHERE id=?").get(spaceId) ||
      !db.prepare("SELECT 1 FROM users WHERE id=?").get(userId))
    throw new Error("Import attachment origin is missing");
  const insert = db.prepare("INSERT INTO uploads(name, uploaded_by, space_id, created_at) VALUES(?,?,?,?)");
  for (const owned of files) {
    const stat = fs.lstatSync(owned.file);
    if (stat.dev !== owned.dev || stat.ino !== owned.ino || !stat.isFile())
      throw new Error("Import attachment ownership changed before attribution");
    insert.run(path.basename(owned.file), userId, spaceId, Date.now());
  }
}

/** Synchronous, outermost import unit of work. Files finish writing before the
 * SQLite commit. Only files exclusively created by this operation are removed
 * on an exception, including a failed commit. No cleanup runs after commit.
 * This is exception recovery, not a cross-filesystem crash-atomic transaction.
 */
export function runImportTransaction<T>(operation: () => T & (T extends PromiseLike<unknown> ? never : unknown)): T {
  if (types.isAsyncFunction(operation))
    throw new Error("Import transaction callbacks must be synchronous");
  const db = getDb();
  if (db.inTransaction || imports.getStore())
    throw new Error("Import requires an outermost transaction");
  const files: CreatedFile[] = [];
  try {
    return imports.run(files, () => db.transaction(() => {
      const result = operation();
      if (result && typeof (result as { then?: unknown }).then === "function")
        throw new Error("Import transaction callbacks must be synchronous");
      return result;
    }).immediate());
  } catch (error) {
    return failed(error, files);
  }
}
