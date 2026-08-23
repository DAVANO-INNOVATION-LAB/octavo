import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDb, DATA_DIR } from "./db";
import { now } from "./util";
import {
  createPage,
  flattenTree,
  getPage,
  pageTree,
  savePage,
  type Space,
} from "./data";
import { parseBlocks } from "./blocks";
import { blocksToMarkdown, markdownToBlocks, splitFrontmatter } from "./markdown";
import { filePathFor, planSync, type FileSide, type PageSide, type Plan, type SyncState } from "./sync";

/**
 * The filesystem half of round-trip sync. The decisions live in ./sync;
 * this reads, writes, and records what was true at the last sync.
 */

export function syncRoot(): string {
  return process.env.OCTAVO_SYNC_DIR || path.join(DATA_DIR, "sync");
}

/** A space's directory, resolved so no slug can escape the sync root. */
export function spaceDir(space: Space): string | null {
  const root = path.resolve(syncRoot());
  const dir = path.resolve(root, space.slug.replace(/[^a-zA-Z0-9._-]/g, "-"));
  return dir === root || dir.startsWith(root + path.sep) ? dir : null;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The Markdown Octavo would write for a page, front matter included. */
export function pageToMarkdown(p: {
  title: string;
  slug: string;
  content: string;
  published: number;
}): string {
  const body = blocksToMarkdown(parseBlocks(p.content));
  return `---\ntitle: ${JSON.stringify(p.title)}\nslug: ${p.slug}\npublished: ${
    p.published === 1 ? "true" : "false"
  }\n---\n\n${body.trimEnd()}\n`;
}

function walk(dir: string, base = ""): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

export function readState(spaceId: string): SyncState[] {
  return getDb()
    .prepare("SELECT path, page_id AS pageId, hash FROM sync_state WHERE space_id = ?")
    .all(spaceId) as SyncState[];
}

function putState(spaceId: string, s: SyncState) {
  getDb()
    .prepare(
      `INSERT INTO sync_state (space_id, path, page_id, hash, synced_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(space_id, path) DO UPDATE SET
         page_id = excluded.page_id, hash = excluded.hash, synced_at = excluded.synced_at`
    )
    .run(spaceId, s.path, s.pageId, s.hash, now());
}

function dropState(spaceId: string, p: string) {
  getDb()
    .prepare("DELETE FROM sync_state WHERE space_id = ? AND path = ?")
    .run(spaceId, p);
}

/** Both sides, described the way the planner expects them. */
export function collect(space: Space): { pages: PageSide[]; files: FileSide[]; dir: string } {
  const dir = spaceDir(space);
  if (!dir) throw new Error("space slug does not resolve inside the sync root");

  const tree = pageTree(space.id, false);
  const flat = flattenTree(tree);
  const pages: PageSide[] = [];
  for (const meta of flat) {
    const full = getPage(meta.id);
    if (!full) continue;
    // Nesting on disk mirrors the page tree, so a repository reads like the
    // book rather than like a database dump.
    const trail: string[] = [];
    let cursor: { slug: string; parent_id: string | null } | null = full;
    const guard = new Set<string>();
    while (cursor && !guard.has(cursor.slug)) {
      guard.add(cursor.slug);
      trail.unshift(cursor.slug);
      cursor = cursor.parent_id ? getPage(cursor.parent_id) : null;
    }
    const md = pageToMarkdown(full);
    pages.push({ id: full.id, path: filePathFor(trail), title: full.title, hash: sha(md) });
  }

  const files: FileSide[] = walk(dir).map((rel) => {
    const raw = fs.readFileSync(path.join(dir, rel), "utf8");
    const [meta] = splitFrontmatter(raw);
    return { path: rel, title: meta.title ?? rel.replace(/\.md$/, ""), hash: sha(raw) };
  });

  return { pages, files, dir };
}

export function planFor(space: Space): Plan & { dir: string } {
  const { pages, files, dir } = collect(space);
  return { ...planSync(pages, files, readState(space.id)), dir };
}

export type SyncReport = {
  written: number;
  imported: number;
  conflicts: { path: string; why: string }[];
  orphans: { path: string; why: string }[];
  removed: number;
  unchanged: number;
};

/**
 * Carry out a plan. Conflicts and orphaned pages are reported and skipped —
 * nothing here overwrites a side that changed, and no page is ever deleted
 * because a file went missing.
 */
export function applySync(space: Space): SyncReport {
  const plan = planFor(space);
  const dir = plan.dir;
  const report: SyncReport = {
    written: 0,
    imported: 0,
    conflicts: [],
    orphans: [],
    removed: 0,
    unchanged: plan.unchanged,
  };

  for (const action of plan.actions) {
    const abs = path.resolve(dir, action.path);
    if (abs !== dir && !abs.startsWith(dir + path.sep)) continue;

    if (action.kind === "conflict") {
      report.conflicts.push({ path: action.path, why: action.why });
      continue;
    }
    if (action.kind === "orphan-page") {
      report.orphans.push({ path: action.path, why: action.why });
      continue;
    }

    if (action.kind === "write") {
      const page = getPage(action.pageId);
      if (!page) continue;
      const md = pageToMarkdown(page);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, md, "utf8");
      putState(space.id, { path: action.path, pageId: page.id, hash: sha(md) });
      report.written++;
      continue;
    }

    if (action.kind === "delete-file") {
      try {
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
      } catch {
        /* already gone */
      }
      dropState(space.id, action.path);
      report.removed++;
      continue;
    }

    if (action.kind === "import") {
      const raw = fs.readFileSync(abs, "utf8");
      const [meta, body] = splitFrontmatter(raw);
      const blocks = markdownToBlocks(body);
      const title = meta.title || path.basename(action.path, ".md");
      const published = meta.published !== "false";

      let pageId = action.pageId;
      if (!pageId || !getPage(pageId)) {
        const created = createPage({ spaceId: space.id, parentId: null });
        pageId = created.id;
      }
      savePage(pageId, {
        title,
        content: JSON.stringify(blocks),
        published,
      });
      // Record what the file said, so the next run attributes correctly.
      putState(space.id, { path: action.path, pageId, hash: sha(raw) });
      report.imported++;
      continue;
    }
  }

  return report;
}
