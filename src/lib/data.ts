import "server-only";
import { getDb } from "./db";
import { newId, now, slugify } from "./util";
import { extractText } from "./blocks";

export type Space = {
  id: string;
  slug: string;
  name: string;
  description: string;
  emoji: string;
  kind: string;
  visibility: string;
  shelf: string;
  typeface: string;
  corners: string;
  accent: string;
  position: number;
  created_at: number;
  updated_at: number;
};

export type Page = {
  id: string;
  space_id: string;
  parent_id: string | null;
  slug: string;
  title: string;
  content: string;
  content_text: string;
  position: number;
  published: number;
  created_at: number;
  updated_at: number;
};

export type PageMeta = Omit<Page, "content" | "content_text">;

export type TreeNode = PageMeta & { children: TreeNode[] };

// ---- spaces ----

export function listSpaces(includePrivate: boolean): Space[] {
  const where = includePrivate ? "" : "WHERE visibility = 'public'";
  return getDb()
    .prepare(`SELECT * FROM spaces ${where} ORDER BY position, created_at`)
    .all() as Space[];
}

export function getSpaceBySlug(slug: string): Space | null {
  return (getDb()
    .prepare("SELECT * FROM spaces WHERE slug = ?")
    .get(slug) ?? null) as Space | null;
}

export function createSpace(input: {
  name: string;
  description?: string;
  kind?: string;
  visibility?: string;
}): Space {
  const db = getDb();
  const id = newId();
  let slug = slugify(input.name);
  // Root-level app routes a space slug must never shadow.
  const RESERVED = new Set([
    "login",
    "setup",
    "new",
    "api",
    "_next",
    "whiteboard",
    "import",
    "account",
    "admin",
  ]);
  if (RESERVED.has(slug)) slug = `${slug}-space`;
  // De-dupe slug if needed.
  const exists = db.prepare("SELECT 1 FROM spaces WHERE slug = ?");
  if (exists.get(slug)) slug = `${slug}-${id.slice(0, 4)}`;
  const t = now();
  const maxPos = (db
    .prepare("SELECT COALESCE(MAX(position), 0) AS p FROM spaces")
    .get() as { p: number }).p;
  db.prepare(
    `INSERT INTO spaces (id, slug, name, description, emoji, kind, visibility, accent, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', ?, ?, 'vermilion', ?, ?, ?)`
  ).run(
    id,
    slug,
    input.name.trim(),
    input.description?.trim() ?? "",
    input.kind ?? "docs",
    input.visibility === "public" ? "public" : "private",
    maxPos + 1,
    t,
    t
  );
  return getSpaceBySlug(slug)!;
}

export function updateSpace(
  id: string,
  fields: Partial<
    Pick<
      Space,
      "name" | "description" | "kind" | "visibility" | "shelf" | "typeface" | "corners"
    >
  >
) {
  const db = getDb();
  const space = db.prepare("SELECT * FROM spaces WHERE id = ?").get(id) as
    | Space
    | undefined;
  if (!space) return;
  db.prepare(
    "UPDATE spaces SET name = ?, description = ?, kind = ?, visibility = ?, shelf = ?, typeface = ?, corners = ?, updated_at = ? WHERE id = ?"
  ).run(
    fields.name?.trim() ?? space.name,
    fields.description?.trim() ?? space.description,
    fields.kind ?? space.kind,
    fields.visibility === "public" || fields.visibility === "private"
      ? fields.visibility
      : space.visibility,
    fields.shelf !== undefined ? fields.shelf.trim().slice(0, 40) : space.shelf,
    ["classic", "atelier", "technical"].includes(fields.typeface ?? "")
      ? (fields.typeface as string)
      : space.typeface,
    ["rounded", "square"].includes(fields.corners ?? "")
      ? (fields.corners as string)
      : space.corners,
    now(),
    id
  );
}

export function deleteSpace(id: string) {
  const db = getDb();
  const pages = db
    .prepare("SELECT id FROM pages WHERE space_id = ?")
    .all(id) as { id: string }[];
  const delFts = db.prepare("DELETE FROM pages_fts WHERE page_id = ?");
  for (const p of pages) delFts.run(p.id);
  db.prepare("DELETE FROM spaces WHERE id = ?").run(id);
}

// ---- pages ----

export function getPage(id: string): Page | null {
  return (getDb().prepare("SELECT * FROM pages WHERE id = ?").get(id) ??
    null) as Page | null;
}

export function getPageBySlug(spaceId: string, slug: string): Page | null {
  return (getDb()
    .prepare("SELECT * FROM pages WHERE space_id = ? AND slug = ?")
    .get(spaceId, slug) ?? null) as Page | null;
}

export function listPages(spaceId: string): PageMeta[] {
  return getDb()
    .prepare(
      `SELECT id, space_id, parent_id, slug, title, position, published, created_at, updated_at
       FROM pages WHERE space_id = ? ORDER BY position, created_at`
    )
    .all(spaceId) as PageMeta[];
}

/** Build the nested page tree for a space. */
export function pageTree(spaceId: string, publishedOnly = false): TreeNode[] {
  const rows = listPages(spaceId).filter(
    (p) => !publishedOnly || p.published === 1
  );
  const byId = new Map<string, TreeNode>();
  for (const r of rows) byId.set(r.id, { ...r, children: [] });
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Depth-first flatten of the tree — the reading order (for prev/next). */
export function flattenTree(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

function uniquePageSlug(spaceId: string, title: string, selfId?: string) {
  const db = getDb();
  let base = slugify(title);
  // /[space]/settings is an app route — a page slug must never shadow it.
  if (base === "settings") base = "settings-page";
  let slug = base;
  let i = 2;
  const q = db.prepare(
    "SELECT id FROM pages WHERE space_id = ? AND slug = ?"
  );
  for (;;) {
    const hit = q.get(spaceId, slug) as { id: string } | undefined;
    if (!hit || hit.id === selfId) return slug;
    slug = `${base}-${i++}`;
  }
}

export function createPage(input: {
  spaceId: string;
  parentId?: string | null;
  title?: string;
  content?: string;
}): Page {
  const db = getDb();
  const id = newId();
  const title = input.title?.trim() || "Untitled";
  const slug = uniquePageSlug(input.spaceId, title === "Untitled" ? id : title);
  const content = input.content ?? "[]";
  const t = now();
  const maxPos = (db
    .prepare(
      "SELECT COALESCE(MAX(position), 0) AS p FROM pages WHERE space_id = ? AND parent_id IS ?"
    )
    .get(input.spaceId, input.parentId ?? null) as { p: number }).p;
  db.prepare(
    `INSERT INTO pages (id, space_id, parent_id, slug, title, content, content_text, position, published, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(
    id,
    input.spaceId,
    input.parentId ?? null,
    slug,
    title,
    content,
    content === "[]" ? "" : extractText(content),
    maxPos + 1,
    t,
    t
  );
  db.prepare("UPDATE spaces SET updated_at = ? WHERE id = ?").run(t, input.spaceId);
  return getPage(id)!;
}

const VERSION_INTERVAL_MS = 10 * 60 * 1000;
const VERSIONS_KEPT = 50;

/** Snapshot the page's current state before it changes — at most one
 *  version per interval, so autosave doesn't flood history. */
function maybeSnapshot(page: Page, force = false) {
  const db = getDb();
  const latest = db
    .prepare(
      "SELECT saved_at FROM page_versions WHERE page_id = ? ORDER BY saved_at DESC LIMIT 1"
    )
    .get(page.id) as { saved_at: number } | undefined;
  if (!force && latest && now() - latest.saved_at < VERSION_INTERVAL_MS) return;
  db.prepare(
    `INSERT INTO page_versions (id, page_id, title, content, content_text, saved_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(newId(), page.id, page.title, page.content, page.content_text, now());
  db.prepare(
    `DELETE FROM page_versions WHERE page_id = ? AND id NOT IN (
       SELECT id FROM page_versions WHERE page_id = ? ORDER BY saved_at DESC LIMIT ?
     )`
  ).run(page.id, page.id, VERSIONS_KEPT);
}

export type PageVersion = {
  id: string;
  page_id: string;
  title: string;
  content: string;
  content_text: string;
  saved_at: number;
};

export function listVersions(pageId: string): Omit<PageVersion, "content">[] {
  return getDb()
    .prepare(
      `SELECT id, page_id, title, content_text, saved_at
       FROM page_versions WHERE page_id = ? ORDER BY saved_at DESC`
    )
    .all(pageId) as Omit<PageVersion, "content">[];
}

/** Unconditional snapshot — used before destructive operations like restore. */
export function snapshotNow(pageId: string) {
  const page = getPage(pageId);
  if (page) maybeSnapshot(page, true);
}

export function getVersion(id: string): PageVersion | null {
  return (getDb()
    .prepare("SELECT * FROM page_versions WHERE id = ?")
    .get(id) ?? null) as PageVersion | null;
}

export function savePage(
  id: string,
  fields: { title?: string; content?: string; published?: boolean }
): Page | null {
  const db = getDb();
  const page = getPage(id);
  if (!page) return null;
  const title = fields.title?.trim() || page.title;
  const content = fields.content ?? page.content;
  if (title !== page.title || content !== page.content) maybeSnapshot(page);
  const contentText =
    fields.content !== undefined ? extractText(content) : page.content_text;
  const published =
    fields.published === undefined ? page.published : fields.published ? 1 : 0;
  // Keep the slug following the title until the page is first published,
  // then freeze it so public URLs stay stable.
  const slug =
    page.published === 0 && fields.title
      ? uniquePageSlug(page.space_id, title, id)
      : page.slug;
  const t = now();
  db.prepare(
    `UPDATE pages SET title = ?, slug = ?, content = ?, content_text = ?, published = ?, updated_at = ? WHERE id = ?`
  ).run(title, slug, content, contentText, published, t, id);
  db.prepare("UPDATE spaces SET updated_at = ? WHERE id = ?").run(
    t,
    page.space_id
  );
  if (fields.content !== undefined) rebuildLinks(id, content);
  // Sync full-text index.
  db.prepare("DELETE FROM pages_fts WHERE page_id = ?").run(id);
  if (published === 1) {
    db.prepare(
      "INSERT INTO pages_fts (page_id, title, body) VALUES (?, ?, ?)"
    ).run(id, title, contentText);
  }
  return getPage(id);
}

export function deletePage(id: string) {
  const db = getDb();
  const page = getPage(id);
  if (!page) return;
  // Collect the subtree (children cascade via FK, but FTS needs manual cleanup).
  const ids: string[] = [];
  const collect = (pid: string) => {
    ids.push(pid);
    const kids = db
      .prepare("SELECT id FROM pages WHERE parent_id = ?")
      .all(pid) as { id: string }[];
    for (const k of kids) collect(k.id);
  };
  collect(id);
  const delFts = db.prepare("DELETE FROM pages_fts WHERE page_id = ?");
  for (const pid of ids) delFts.run(pid);
  db.prepare("DELETE FROM pages WHERE id = ?").run(id);
}

// ---- search ----

export type SearchHit = {
  page_id: string;
  title: string;
  snippet: string;
  space_slug: string;
  space_name: string;
  page_slug: string;
};

export function searchPages(
  query: string,
  includePrivate: boolean,
  limit = 12
): SearchHit[] {
  const q = query.trim();
  if (!q) return [];
  // Prefix-match each term for as-you-type search.
  const match = q
    .replace(/["'*]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t}"*`)
    .join(" ");
  if (!match) return [];
  try {
    const rows = getDb()
      .prepare(
        `SELECT f.page_id, p.title, p.slug AS page_slug,
                s.slug AS space_slug, s.name AS space_name,
                snippet(pages_fts, 2, char(1), char(2), '…', 14) AS snippet
         FROM pages_fts f
         JOIN pages p ON p.id = f.page_id
         JOIN spaces s ON s.id = p.space_id
         WHERE pages_fts MATCH ?
           AND (? = 1 OR s.visibility = 'public')
         ORDER BY bm25(pages_fts, 0, 3.0, 1.0)
         LIMIT ?`
      )
      .all(match, includePrivate ? 1 : 0, limit) as SearchHit[];
    // Escape page-authored text, then swap the sentinel chars for <mark> tags,
    // so snippets are safe to render as HTML.
    for (const r of rows) {
      r.snippet = r.snippet
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\u0001/g, "<mark>")
        .replace(/\u0002/g, "</mark>");
    }
    return rows;
  } catch {
    return [];
  }
}

// ---- comments (technical docs collaborate; cookbooks stay clean) ----

/** Space kinds whose reader pages carry a discussion section. */
export const COMMENTABLE_KINDS = new Set(["docs", "wiki", "articles"]);

export type Comment = {
  id: string;
  page_id: string;
  user_id: string;
  body: string;
  created_at: number;
  author: string;
};

export function listComments(pageId: string): Comment[] {
  return getDb()
    .prepare(
      `SELECT c.id, c.page_id, c.user_id, c.body, c.created_at, u.name AS author
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.page_id = ? ORDER BY c.created_at`
    )
    .all(pageId) as Comment[];
}

export function addComment(pageId: string, userId: string, body: string) {
  const text = body.trim().slice(0, 4000);
  if (!text) return;
  getDb()
    .prepare(
      "INSERT INTO comments (id, page_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(newId(), pageId, userId, text, now());
}

export function deleteComment(id: string) {
  getDb().prepare("DELETE FROM comments WHERE id = ?").run(id);
}

// ---- wikilinks & backlinks ----

/** Hrefs inside a document that point at library pages: /space/page. */
function internalLinkTargets(content: string): string[] {
  const ids: string[] = [];
  const hrefs = new Set<string>();
  const walk = (blocks: { content?: unknown; children?: unknown[] }[]) => {
    for (const b of blocks) {
      const inline = (c: unknown) => {
        if (!Array.isArray(c)) return;
        for (const n of c as { type: string; href?: string; content?: unknown }[]) {
          if (n.type === "link" && typeof n.href === "string") hrefs.add(n.href);
          if (n.content) inline(n.content);
        }
      };
      inline(b.content);
      if (Array.isArray(b.children)) walk(b.children as typeof blocks);
    }
  };
  try {
    walk(JSON.parse(content));
  } catch {
    return ids;
  }
  const db = getDb();
  for (const href of hrefs) {
    const m = href.match(/^\/([a-z0-9-]+)\/([a-z0-9-]+)$/);
    if (!m) continue;
    const row = db
      .prepare(
        `SELECT p.id FROM pages p JOIN spaces s ON s.id = p.space_id
         WHERE s.slug = ? AND p.slug = ?`
      )
      .get(m[1], m[2]) as { id: string } | undefined;
    if (row) ids.push(row.id);
  }
  return ids;
}

export function rebuildLinks(pageId: string, content: string) {
  const db = getDb();
  db.prepare("DELETE FROM page_links WHERE from_page = ?").run(pageId);
  const ins = db.prepare(
    "INSERT OR IGNORE INTO page_links (from_page, to_page) VALUES (?, ?)"
  );
  for (const target of internalLinkTargets(content)) {
    if (target !== pageId) ins.run(pageId, target);
  }
}

export type Backlink = {
  page_id: string;
  title: string;
  page_slug: string;
  space_slug: string;
  space_name: string;
};

/** Pages that link to this one — the "referenced by" panel. */
export function backlinks(pageId: string, includePrivate: boolean): Backlink[] {
  return getDb()
    .prepare(
      `SELECT p.id AS page_id, p.title, p.slug AS page_slug,
              s.slug AS space_slug, s.name AS space_name
       FROM page_links l
       JOIN pages p ON p.id = l.from_page
       JOIN spaces s ON s.id = p.space_id
       WHERE l.to_page = ? AND p.published = 1
         AND (? = 1 OR s.visibility = 'public')
       ORDER BY s.name, p.title`
    )
    .all(pageId, includePrivate ? 1 : 0) as Backlink[];
}

/** Title lookup for the editor's page-link menu. */
export function lookupPages(q: string, limit = 8): Backlink[] {
  const like = `%${q.trim().replace(/[%_]/g, "")}%`;
  return getDb()
    .prepare(
      `SELECT p.id AS page_id, p.title, p.slug AS page_slug,
              s.slug AS space_slug, s.name AS space_name
       FROM pages p JOIN spaces s ON s.id = p.space_id
       WHERE p.title LIKE ? ORDER BY p.updated_at DESC LIMIT ?`
    )
    .all(like, limit) as Backlink[];
}
