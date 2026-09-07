import "server-only";
import { getDb } from "./db";
import { now } from "./util";
import { canReadSpace } from "./roles";
import { getSpace } from "./data";
import type { User } from "./auth";

/**
 * Who may read an uploaded file.
 *
 * An upload used to be an anonymous blob on disk: the endpoint checked the
 * shape of the name and served the bytes, so every attachment in every
 * private space — and, once tenants existed, in every tenant — was readable
 * by anyone who had the URL. URLs are not a permission. They leak into
 * referrers, logs, chat, browser history and repositories, and neither
 * removing a file from a page nor removing a person from a space takes one
 * back.
 *
 * A file therefore inherits the readability of the spaces that reference it.
 * An image on a public page still loads for a stranger, because the page it
 * is on is public. An attachment in a private space is refused to everyone
 * who could not open that space, by exactly the check the space itself uses.
 */

const FILE_REF = /\/api\/files\/([0-9a-z]+\.[0-9a-z]+)/g;

/** Every upload named anywhere in a document. */
export function fileNamesIn(content: string): string[] {
  return [...new Set([...content.matchAll(FILE_REF)].map((m) => m[1]))];
}

/** Record an upload at the moment it is made. */
export function recordUpload(name: string, userId: string, spaceId: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO uploads (name, uploaded_by, space_id, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO NOTHING`
    )
    .run(name, userId, spaceId, now());
}

/**
 * Bring a page's file references up to date.
 *
 * References are only ever added, never removed. A file that has left one
 * page may still be on another, in an older version, or about to be pasted
 * back; dropping the reference the moment it disappears from one document
 * would break the file everywhere else it is used.
 */
export function syncUploadRefs(spaceId: string, content: string): void {
  const names = fileNamesIn(content);
  if (names.length === 0) return;
  const stmt = getDb().prepare(
    "INSERT INTO upload_refs (name, space_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
  );
  for (const n of names) stmt.run(n, spaceId);
}

/**
 * May this principal read this file?
 *
 * Deliberately ordered so the common case — an image on a page someone is
 * already reading — is answered by the same space check that let them open
 * the page.
 */
export function canReadUpload(user: User | null, name: string): boolean {
  const db = getDb();

  // Someone who runs the instance can read anything in it already.
  if (user?.role === "admin") return true;

  const spaceIds = (
    db.prepare("SELECT space_id FROM upload_refs WHERE name = ?").all(name) as {
      space_id: string;
    }[]
  ).map((r) => r.space_id);

  const record = db.prepare("SELECT uploaded_by, space_id FROM uploads WHERE name = ?").get(name) as
    | { uploaded_by: string; space_id: string | null }
    | undefined;
  if (record?.space_id) spaceIds.push(record.space_id);

  for (const id of [...new Set(spaceIds)]) {
    const space = getSpace(id);
    if (space && canReadSpace(user, space)) return true;
  }

  // A file just uploaded and not yet placed on a page belongs to whoever
  // uploaded it — otherwise the editor could not show what it just sent.
  if (record && user && record.uploaded_by === user.id) return true;

  // Anything else is a file no page claims and nobody here owns.
  return false;
}

/**
 * Attribute existing uploads to the spaces already using them.
 *
 * Run once, when the reference table first appears. Without it every file
 * that predates this becomes unreadable, which would empty the images out of
 * a working library — a fix that breaks the thing it protects is not a fix.
 */
export function backfillUploadRefs(): number {
  const db = getDb();
  const done = db.prepare("SELECT COUNT(*) AS c FROM upload_refs").get() as { c: number };
  if (done.c > 0) return 0;

  let added = 0;
  const stmt = db.prepare(
    "INSERT INTO upload_refs (name, space_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
  );
  const rows = db
    .prepare("SELECT space_id, content FROM pages WHERE content LIKE '%/api/files/%'")
    .all() as { space_id: string; content: string }[];
  // Old versions count: a file referenced only by a superseded revision is
  // still that space's file, and history should not stop rendering.
  const versions = db
    .prepare(
      `SELECT p.space_id, v.content FROM page_versions v JOIN pages p ON p.id = v.page_id
        WHERE v.content LIKE '%/api/files/%'`
    )
    .all() as { space_id: string; content: string }[];

  db.transaction(() => {
    for (const r of [...rows, ...versions])
      for (const n of fileNamesIn(r.content)) {
        stmt.run(n, r.space_id);
        added++;
      }
  })();
  return added;
}
