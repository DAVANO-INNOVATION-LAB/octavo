import "server-only";
import { getDb } from "./db";
import { now } from "./util";
import { canEditSpace, canReadSpace } from "./roles";
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
 * A file is authorized through its recorded origin and current published references.
 * An image on a public page still loads for a stranger, because the page it
 * is on is public. An attachment in a private space is refused to everyone
 * who could not open that space, by exactly the check the space itself uses.
 */

const FILE_REF = /\/api\/files\/([0-9a-z]+\.[0-9a-z]+)/g;

/** Every upload named anywhere in a document. */
export function fileNamesIn(content: string): string[] {
  const names = new Set([...content.matchAll(FILE_REF)].map((m) => m[1]));
  // Model blocks also accept a bare data filename. Treat only that structured
  // reference as a publication reference, not arbitrary matching prose.
  try {
    const parsed: unknown = JSON.parse(content);
    const pending: unknown[] = Array.isArray(parsed) ? [...parsed] : [];
    while (pending.length) {
      const block = pending.pop();
      if (!block || typeof block !== "object") continue;
      const value = block as { type?: unknown; props?: { source?: unknown; dataUrl?: unknown }; children?: unknown };
      if (value.type === "model3d" && value.props?.source === "data" && typeof value.props.dataUrl === "string") {
        const name = value.props.dataUrl.replace(/^\/api\/files\//, "");
        if (/^[A-Za-z0-9_-]+\.(csv|tsv|json|txt)$/.test(name)) names.add(name);
      }
      if (Array.isArray(value.children)) pending.push(...value.children);
    }
  } catch { /* Covers and historical plain references are not JSON. */ }
  return [...names];
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
  if (user?.role === "admin") return true;
  const record = db.prepare("SELECT uploaded_by, space_id FROM uploads WHERE name = ?").get(name) as
    | { uploaded_by: string; space_id: string | null } | undefined;

  // The recorded origin is authority. A filename pasted into another space
  // must never grant access to that space's readers.
  const origin = record?.space_id ?? null;
  // Legacy mutable references are not proof of provenance. Keep bytes intact,
  // but require operator-assisted reupload instead of granting guessed access.
  if (!origin) {
    // Unplaced uploads are private to their uploader until explicitly scoped.
    return !!record && !!user && record.uploaded_by === user.id;
  }
  const space = getSpace(origin);
  if (!space || !canReadSpace(user, space)) return false;
  // Editors may preview drafts/history. Losing source access also revokes the
  // uploader's fallback; historical ownership is not an evergreen grant.
  if (canEditSpace(user, origin)) return true;
  const pages = db.prepare("SELECT content, cover FROM pages WHERE space_id = ? AND published = 1").all(origin) as
    { content: string; cover: string }[];
  return pages.some(page => fileNamesIn(page.content).includes(name) || fileNamesIn(page.cover).includes(name));
}

/** Populate historical reference inventory only. These mutable references do
 * not confer read access or establish an immutable upload origin. Legacy files
 * remain on disk for explicit administrator-assisted recovery.
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
  // Include old versions for inventory and recovery, never authorization.
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
