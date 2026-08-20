import "server-only";
import { getDb } from "./db";

/** Simple instance settings in the kv table. */
export function getSetting(key: string): string | null {
  const row = getDb()
    .prepare("SELECT value FROM kv WHERE key = ?")
    .get(`setting:${key}`) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string | null) {
  const db = getDb();
  if (value === null || value === "") {
    db.prepare("DELETE FROM kv WHERE key = ?").run(`setting:${key}`);
  } else {
    db.prepare(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(`setting:${key}`, value);
  }
}
