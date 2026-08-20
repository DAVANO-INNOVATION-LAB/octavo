import "server-only";
import { getDb } from "./db";
import { now } from "./util";

/**
 * Claim the right to seed a page's shared document, atomically.
 *
 * The first caller inserts an empty row and is told to seed; everyone after
 * that hits the primary key and is told not to. SQLite's single writer makes
 * this a real lock rather than a hopeful one.
 */
export function claimSeed(pageId: string): boolean {
  try {
    const res = getDb()
      .prepare(
        `INSERT INTO collab_docs (page_id, state, updated_at)
         VALUES (?, zeroblob(0), ?)
         ON CONFLICT(page_id) DO NOTHING`
      )
      .run(pageId, now());
    return res.changes === 1;
  } catch {
    // Never block editing on a seeding decision; the worst case is an empty
    // document the author can retype, not a lost page.
    return false;
  }
}
