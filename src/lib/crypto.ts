import "server-only";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { getDb } from "./db";

// AES-256-GCM at-rest encryption for connector credentials, keyed on the
// per-instance secret so a stolen database file alone does not yield secrets.

function key(): Buffer {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM kv WHERE key = 'instance_secret'")
    .get() as { value: string } | undefined;
  let secret = row?.value;
  if (!secret) {
    secret = randomBytes(32).toString("hex");
    db.prepare(
      "INSERT OR IGNORE INTO kv (key, value) VALUES ('instance_secret', ?)"
    ).run(secret);
  }
  // Derive a 32-byte key from the hex secret.
  return createHash("sha256").update(secret).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  const [ivB, tagB, dataB] = stored.split(":");
  if (!ivB || !tagB || !dataB) return "";
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key(),
      Buffer.from(ivB, "base64")
    );
    decipher.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return "";
  }
}
