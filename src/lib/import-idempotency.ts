import "server-only";
import crypto from "node:crypto";
import type { User } from "./auth";
import { getDb } from "./db";
import { getSpace } from "./data";
import { canReadSpace } from "./roles";

export function importIdempotencyKey(form: FormData): string | null {
  const values = form.getAll("idempotencyKey");
  if (!values.length) return null;
  if (values.length !== 1 || typeof values[0] !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(values[0])) throw new Error("Invalid import retry key");
  return values[0];
}

/** Versioned, length-framed request identity. No source bytes are retained. */
export function importRequestFingerprint(filename: string, bytes: Buffer, name: string): string {
  const hash = crypto.createHash("sha256");
  for (const value of ["octavo/upload-request/v1", filename, name, crypto.createHash("sha256").update(bytes).digest("hex")]) {
    const field = Buffer.from(value, "utf8"), length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(field.length));
    hash.update(length); hash.update(field);
  }
  return hash.digest("hex");
}

function transaction() {
  const db = getDb();
  if (!db.inTransaction) throw new Error("Import retry lookup requires an active import transaction");
  return db;
}

/** Called under the outer immediate import transaction, before any conversion. */
export function replayImport(user: User, key: string, fingerprint: string): string | null {
  const row = transaction().prepare("SELECT fingerprint,space_id FROM import_idempotency WHERE user_id=? AND request_key=?").get(user.id,key) as {fingerprint:string;space_id:string|null}|undefined;
  if (!row) return null;
  if (row.fingerprint !== fingerprint) throw new Error("This import retry key was already used for a different file or import options. Start a new import to use different inputs.");
  const space = row.space_id ? getSpace(row.space_id) : null;
  if (!space || !canReadSpace(user,space)) throw new Error("The previous import is no longer available. This retry key cannot create another import.");
  return space.slug;
}

export function recordImport(userId: string, key: string, fingerprint: string, spaceId: string): void {
  transaction().prepare("INSERT INTO import_idempotency(user_id,request_key,fingerprint,space_id,completed_at) VALUES(?,?,?,?,?)").run(userId,key,fingerprint,spaceId,Date.now());
}
