import "server-only";
import { asVariantKind, type VariantSpace } from "./variants";
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
  variant_group: string;
  variant_label: string;
  variant_kind: string;
  variant_position: number;
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

/**
 * Which spaces a query may see. `"all"` is an instance administrator; an
 * array is the private spaces this person belongs to, on top of the public
 * ones. A boolean cannot express "signed in, but not a member of that", which
 * is the case that matters.
 */
export type SpaceScope = "all" | string[];

/**
 * A condition restricting a query to the spaces in scope, with its bound
 * parameters. Ids are bound rather than interpolated: these come from our own
 * tables today, and a query built by string-joining identifiers is one
 * refactor away from taking one that does not.
 */
export function scopeClause(
  scope: SpaceScope,
  visibilityColumn = "visibility",
  idColumn = "id"
): { sql: string; params: string[] } {
  if (scope === "all") return { sql: "", params: [] };
  if (scope.length === 0) return { sql: `${visibilityColumn} = 'public'`, params: [] };
  const holes = scope.map(() => "?").join(",");
  return {
    sql: `(${visibilityColumn} = 'public' OR ${idColumn} IN (${holes}))`,
    params: [...scope],
  };
}

export function listSpaces(scope: SpaceScope): Space[] {
  const { sql, params } = scopeClause(scope);
  const where = sql ? `WHERE ${sql}` : "";
  return getDb()
    .prepare(`SELECT * FROM spaces ${where} ORDER BY position, created_at`)
    .all(...params) as Space[];
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
    "graph",
    "sitemap.xml",
    "robots.txt",
    "llms-full.txt",
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
  if (["settings", "members", "connectors", "raw", "history", "print"].includes(base))
    base = `${base}-page`;
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
  /** New pages start as drafts; an import of an existing document does not. */
  published?: boolean;
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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.spaceId,
    input.parentId ?? null,
    slug,
    title,
    content,
    content === "[]" ? "" : extractText(content),
    maxPos + 1,
    input.published ? 1 : 0,
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
  scope: SpaceScope,
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
  const scoped = scopeClause(scope, "s.visibility", "s.id");
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
           ${scoped.sql ? `AND ${scoped.sql}` : ""}
         ORDER BY bm25(pages_fts, 0, 3.0, 1.0)
         LIMIT ?`
      )
      .all(match, ...scoped.params, limit) as SearchHit[];
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
  /** The block this thread hangs from. Empty means the thread is about the page. */
  block_id: string;
  /** Null on a thread root; the root's id on a reply. */
  parent_id: string | null;
  resolved: number;
  resolved_by: string | null;
  resolved_at: number | null;
  /** The passage as it read when the thread started. */
  anchor_text: string;
  /** Display name of whoever resolved it. */
  resolver: string | null;
};

/** A root comment and everything said in reply to it, oldest first. */
export type Thread = {
  root: Comment;
  replies: Comment[];
};

const COMMENT_COLS = `c.id, c.page_id, c.user_id, c.body, c.created_at,
   c.block_id, c.parent_id, c.resolved, c.resolved_by, c.resolved_at,
   c.anchor_text, u.name AS author,
   (SELECT name FROM users WHERE id = c.resolved_by) AS resolver`;

/** Every comment on a page, flat and in the order it was written. */
export function listComments(pageId: string): Comment[] {
  return getDb()
    .prepare(
      `SELECT ${COMMENT_COLS}
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.page_id = ? ORDER BY c.created_at`
    )
    .all(pageId) as Comment[];
}

/**
 * Comments grouped into threads. A reply whose root has been deleted would
 * otherwise vanish from the page while still sitting in the table, so orphans
 * are promoted to roots rather than dropped.
 */
export function listThreads(pageId: string): Thread[] {
  const all = listComments(pageId);
  const byId = new Map(all.map((c) => [c.id, c]));
  const threads = new Map<string, Thread>();
  for (const c of all) {
    if (!c.parent_id || !byId.has(c.parent_id)) {
      threads.set(c.id, { root: c, replies: [] });
    }
  }
  for (const c of all) {
    if (c.parent_id && threads.has(c.parent_id)) {
      threads.get(c.parent_id)!.replies.push(c);
    }
  }
  return [...threads.values()];
}

/**
 * Threads that hang off a block, keyed by block id. The reader uses this to
 * decide which passages carry a marker, so resolved threads are counted
 * separately — a settled conversation should not shout.
 */
export function blockThreadCounts(
  pageId: string
): Map<string, { open: number; resolved: number }> {
  const out = new Map<string, { open: number; resolved: number }>();
  for (const t of listThreads(pageId)) {
    if (!t.root.block_id) continue;
    const e = out.get(t.root.block_id) ?? { open: 0, resolved: 0 };
    if (t.root.resolved) e.resolved++;
    else e.open++;
    out.set(t.root.block_id, e);
  }
  return out;
}

export function addComment(
  pageId: string,
  userId: string,
  body: string,
  opts: { blockId?: string; parentId?: string; anchorText?: string } = {}
): string | null {
  const text = body.trim().slice(0, 4000);
  if (!text) return null;
  const db = getDb();

  // A reply inherits the root's anchor: a thread is about one passage, and
  // letting replies carry their own would let a conversation drift silently.
  let blockId = opts.blockId ?? "";
  let anchorText = (opts.anchorText ?? "").slice(0, 300);
  let parentId = opts.parentId ?? null;
  if (parentId) {
    const root = db
      .prepare("SELECT id, page_id, block_id, anchor_text, parent_id FROM comments WHERE id = ?")
      .get(parentId) as
      | { id: string; page_id: string; block_id: string; anchor_text: string; parent_id: string | null }
      | undefined;
    if (!root || root.page_id !== pageId) return null;
    // Replying to a reply still belongs to the same thread, not a deeper one.
    parentId = root.parent_id ?? root.id;
    blockId = root.block_id;
    anchorText = root.anchor_text;
  }

  const id = newId();
  db.prepare(
    `INSERT INTO comments (id, page_id, user_id, body, created_at, block_id, parent_id, anchor_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, pageId, userId, text, now(), blockId, parentId, anchorText);
  return id;
}

/** Deleting a thread root takes its replies with it — half a conversation reads worse than none. */
export function deleteComment(id: string) {
  const db = getDb();
  db.prepare("DELETE FROM comments WHERE parent_id = ?").run(id);
  db.prepare("DELETE FROM comments WHERE id = ?").run(id);
}

/**
 * Everyone who can be addressed in a comment. Names only — a mention list is
 * shown to anyone who can comment, and email addresses are not theirs to see.
 */
export function mentionableUsers(): { id: string; name: string }[] {
  return getDb()
    .prepare("SELECT id, name FROM users ORDER BY name")
    .all() as { id: string; name: string }[];
}

/** Who wrote a comment, for authorization checks. */
export function commentAuthor(id: string): string | null {
  const row = getDb()
    .prepare("SELECT user_id FROM comments WHERE id = ?")
    .get(id) as { user_id: string } | undefined;
  return row?.user_id ?? null;
}

export function setThreadResolved(id: string, userId: string, resolved: boolean) {
  getDb()
    .prepare(
      "UPDATE comments SET resolved = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND parent_id IS NULL"
    )
    .run(resolved ? 1 : 0, resolved ? userId : null, resolved ? now() : null, id);
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
export function backlinks(pageId: string, scope: SpaceScope): Backlink[] {
  const bscope = scopeClause(scope, "s.visibility", "s.id");
  return getDb()
    .prepare(
      `SELECT p.id AS page_id, p.title, p.slug AS page_slug,
              s.slug AS space_slug, s.name AS space_name
       FROM page_links l
       JOIN pages p ON p.id = l.from_page
       JOIN spaces s ON s.id = p.space_id
       WHERE l.to_page = ? AND p.published = 1
           ${bscope.sql ? `AND ${bscope.sql}` : ""}
       ORDER BY s.name, p.title`
    )
    .all(pageId, ...bscope.params) as Backlink[];
}

/** Title lookup for the editor's page-link menu. */
export function lookupPages(q: string, scope: SpaceScope, limit = 8): Backlink[] {
  const like = `%${q.trim().replace(/[%_]/g, "")}%`;
  const lscope = scopeClause(scope, "s.visibility", "s.id");
  return getDb()
    .prepare(
      `SELECT p.id AS page_id, p.title, p.slug AS page_slug,
              s.slug AS space_slug, s.name AS space_name
       FROM pages p JOIN spaces s ON s.id = p.space_id
       WHERE p.title LIKE ?
             ${lscope.sql ? `AND ${lscope.sql}` : ""}
       ORDER BY p.updated_at DESC LIMIT ?`
    )
    .all(like, ...lscope.params, limit) as Backlink[];
}

// ---- graph ----

export type GraphData = {
  nodes: { id: string; title: string; space: string; href: string; degree: number }[];
  edges: { from: string; to: string }[];
};

/** The library's link graph — respects visibility like everything else. */
export function linkGraph(scope: SpaceScope): GraphData {
  const gscope = scopeClause(scope, "s.visibility", "s.id");
  const db = getDb();
  const nodes = db
    .prepare(
      `SELECT p.id, p.title, s.name AS space, s.slug AS space_slug, p.slug
       FROM pages p JOIN spaces s ON s.id = p.space_id
       WHERE p.published = 1 ${gscope.sql ? `AND ${gscope.sql}` : ""}`
    )
    .all(...gscope.params) as {
    id: string;
    title: string;
    space: string;
    space_slug: string;
    slug: string;
  }[];
  const allowed = new Set(nodes.map((n) => n.id));
  const edges = (
    db.prepare("SELECT from_page, to_page FROM page_links").all() as {
      from_page: string;
      to_page: string;
    }[]
  )
    .filter((e) => allowed.has(e.from_page) && allowed.has(e.to_page))
    .map((e) => ({ from: e.from_page, to: e.to_page }));

  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  // Only linked pages appear — an unconnected library is not a graph.
  return {
    nodes: nodes
      .filter((n) => degree.has(n.id))
      .map((n) => ({
        id: n.id,
        title: n.title,
        space: n.space,
        href: `/${n.space_slug}/${n.slug}`,
        degree: degree.get(n.id) ?? 0,
      })),
    edges,
  };
}

// ---- broken links ----

export type BrokenLink = {
  page_id: string;
  page_title: string;
  page_slug: string;
  space_slug: string;
  space_name: string;
  href: string;
  reason: string;
};

/**
 * Internal links that no longer resolve. Checks only in-library hrefs —
 * external URLs are not ours to judge and would need network calls.
 */
export function brokenLinks(): BrokenLink[] {
  const db = getDb();
  const pages = db
    .prepare(
      `SELECT p.id, p.title, p.slug, p.content, s.slug AS space_slug, s.name AS space_name
       FROM pages p JOIN spaces s ON s.id = p.space_id WHERE p.published = 1`
    )
    .all() as {
    id: string; title: string; slug: string; content: string;
    space_slug: string; space_name: string;
  }[];

  const resolve = db.prepare(
    `SELECT p.published FROM pages p JOIN spaces s ON s.id = p.space_id
     WHERE s.slug = ? AND p.slug = ?`
  );
  const spaceExists = db.prepare("SELECT 1 FROM spaces WHERE slug = ?");
  const out: BrokenLink[] = [];

  for (const page of pages) {
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
      walk(JSON.parse(page.content));
    } catch {
      continue;
    }

    for (const href of hrefs) {
      if (!href.startsWith("/")) continue;             // external — not ours
      if (href.startsWith("/api/")) continue;          // uploads and exports
      const clean = href.split(/[?#]/)[0].replace(/\/$/, "");
      if (!clean || clean === "") continue;
      const parts = clean.slice(1).split("/");
      let reason = "";
      if (parts.length === 1) {
        if (!spaceExists.get(parts[0])) reason = "no such space";
      } else if (parts.length === 2) {
        const hit = resolve.get(parts[0], parts[1]) as { published: number } | undefined;
        if (!hit) reason = "no such page";
        else if (hit.published === 0) reason = "target is an unpublished draft";
      }
      if (reason)
        out.push({
          page_id: page.id, page_title: page.title, page_slug: page.slug,
          space_slug: page.space_slug, space_name: page.space_name,
          href, reason,
        });
    }
  }
  return out;
}

// ---- analytics ----
//
// Deliberately minimal and local: a per-page daily counter, the search terms
// people typed, and a helpful/not-helpful vote. No cookies, no identifiers,
// no third party — the numbers exist to find stale and missing pages, not to
// follow readers around.

export function recordView(pageId: string) {
  const day = new Date().toISOString().slice(0, 10);
  getDb()
    .prepare(
      `INSERT INTO page_views (page_id, day, views) VALUES (?, ?, 1)
       ON CONFLICT(page_id, day) DO UPDATE SET views = views + 1`
    )
    .run(pageId, day);
}

export function recordSearch(query: string, hits: number) {
  const q = query.trim().slice(0, 120);
  if (!q) return;
  getDb()
    .prepare("INSERT INTO searches (query, hits, at) VALUES (?, ?, ?)")
    .run(q, hits, now());
}

export function recordFeedback(pageId: string, helpful: boolean, note = "") {
  getDb()
    .prepare(
      "INSERT INTO feedback (id, page_id, helpful, note, at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(newId(), pageId, helpful ? 1 : 0, note.trim().slice(0, 2000), now());
}

export type PageInsight = {
  page_id: string;
  title: string;
  page_slug: string;
  space_slug: string;
  space_name: string;
  views: number;
  updated_at: number;
  helpful: number;
  unhelpful: number;
};

export function pageInsights(days = 30): {
  mostRead: PageInsight[];
  stale: PageInsight[];
  unhelpful: PageInsight[];
  neverRead: PageInsight[];
  totalViews: number;
} {
  const db = getDb();
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const base = `
    SELECT p.id AS page_id, p.title, p.slug AS page_slug,
           s.slug AS space_slug, s.name AS space_name, p.updated_at,
           COALESCE((SELECT SUM(views) FROM page_views v WHERE v.page_id = p.id AND v.day >= ?), 0) AS views,
           COALESCE((SELECT COUNT(*) FROM feedback f WHERE f.page_id = p.id AND f.helpful = 1), 0) AS helpful,
           COALESCE((SELECT COUNT(*) FROM feedback f WHERE f.page_id = p.id AND f.helpful = 0), 0) AS unhelpful
    FROM pages p JOIN spaces s ON s.id = p.space_id
    WHERE p.published = 1`;
  const all = db.prepare(base).all(since) as PageInsight[];
  const totalViews = all.reduce((n, p) => n + p.views, 0);
  const staleCutoff = Date.now() - 180 * 86400_000;
  return {
    mostRead: [...all].sort((a, b) => b.views - a.views).filter((p) => p.views > 0).slice(0, 8),
    // Read often but not touched in months — the pages most worth revisiting.
    stale: [...all]
      .filter((p) => p.updated_at < staleCutoff && p.views > 0)
      .sort((a, b) => b.views - a.views)
      .slice(0, 8),
    unhelpful: [...all]
      .filter((p) => p.unhelpful > 0)
      .sort((a, b) => b.unhelpful - a.unhelpful)
      .slice(0, 8),
    neverRead: [...all].filter((p) => p.views === 0).slice(0, 8),
    totalViews,
  };
}

export type SearchInsight = { query: string; times: number; hits: number };

/** What people looked for — and especially what they did not find. */
export function searchInsights(days = 30): {
  top: SearchInsight[];
  empty: SearchInsight[];
} {
  const since = now() - days * 86400_000;
  const rows = getDb()
    .prepare(
      `SELECT query, COUNT(*) AS times, MAX(hits) AS hits
       FROM searches WHERE at >= ? GROUP BY LOWER(query) ORDER BY times DESC LIMIT 40`
    )
    .all(since) as SearchInsight[];
  return {
    top: rows.slice(0, 10),
    empty: rows.filter((r) => r.hits === 0).slice(0, 10),
  };
}

// ---- content variants ----

/**
 * Sibling spaces in the same variant group, plus which of them have a page
 * with the given slug. One query for the group and one for the slugs, rather
 * than a lookup per sibling.
 */
export function variantSiblings(space: {
  id: string;
  variant_group?: string;
}): { spaces: VariantSpace[]; slugs: Map<string, Set<string>> } {
  const group = (space.variant_group ?? "").trim();
  if (!group) return { spaces: [], slugs: new Map() };
  const db = getDb();
  const spaces = db
    .prepare(
      `SELECT id, slug, name, variant_group, variant_label, variant_kind, variant_position
       FROM spaces WHERE variant_group = ? ORDER BY variant_position`
    )
    .all(group) as VariantSpace[];
  const slugs = new Map<string, Set<string>>();
  if (spaces.length > 1) {
    const rows = db
      .prepare(
        `SELECT space_id, slug FROM pages
         WHERE space_id IN (${spaces.map(() => "?").join(",")})`
      )
      .all(...spaces.map((s) => s.id)) as { space_id: string; slug: string }[];
    for (const r of rows) {
      if (!slugs.has(r.space_id)) slugs.set(r.space_id, new Set());
      slugs.get(r.space_id)!.add(r.slug);
    }
  }
  return { spaces, slugs };
}

/** Variant groups an admin can attach a space to, with how many are in each. */
export function variantGroups(): { group: string; count: number }[] {
  return getDb()
    .prepare(
      `SELECT variant_group AS "group", COUNT(*) AS count FROM spaces
       WHERE variant_group != '' GROUP BY variant_group ORDER BY variant_group`
    )
    .all() as { group: string; count: number }[];
}

export function setSpaceVariant(
  spaceId: string,
  v: { group: string; label: string; kind: string; position: number }
) {
  getDb()
    .prepare(
      `UPDATE spaces SET variant_group = ?, variant_label = ?, variant_kind = ?,
         variant_position = ?, updated_at = ? WHERE id = ?`
    )
    .run(
      v.group.trim().slice(0, 80),
      v.label.trim().slice(0, 60),
      asVariantKind(v.kind),
      Number.isFinite(v.position) ? v.position : 0,
      now(),
      spaceId
    );
}
