import type Database from "better-sqlite3";

export const SEARCH_INDEX_REPAIR_KEY = "migration:published-search-index:v1";

type IndexedPage = { id: string; title: string; content_text: string; published: number };

/** Derived data only. Call inside the transaction that creates or saves a page. */
export function syncPageSearchIndex(db: Database.Database, page: IndexedPage, newlyCreated = false): void {
  if (!db.inTransaction) throw new Error("Search index updates require a page transaction");
  // A newly inserted, unique page ID cannot have a prior entry. Avoid a full
  // scan of the unindexed page_id column on every page in a bulk import.
  if (!newlyCreated) db.prepare("DELETE FROM pages_fts WHERE page_id = ?").run(page.id);
  if (page.published === 1) {
    db.prepare("INSERT INTO pages_fts (page_id, title, body) VALUES (?, ?, ?)")
      .run(page.id, page.title, page.content_text);
  }
}

/** One-time repair for imports created before createPage maintained the index.
 * Rebuild from stored page text, never save/re-publish pages to repair search.
 * Runs on writable database startup, not requests; replicas receive the index
 * with their snapshot. The marker commits only with the complete replacement.
 */
export function repairPageSearchIndex(db: Database.Database): boolean {
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM kv WHERE key = ?").get(SEARCH_INDEX_REPAIR_KEY)) return false;
    db.exec("DELETE FROM pages_fts");
    db.exec("INSERT INTO pages_fts (page_id, title, body) SELECT id, title, content_text FROM pages WHERE published = 1");
    db.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run(SEARCH_INDEX_REPAIR_KEY, "complete");
    return true;
  }).immediate();
}
