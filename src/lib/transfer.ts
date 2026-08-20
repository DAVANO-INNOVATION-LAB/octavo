import "server-only";
import {
  Space,
  TreeNode,
  createPage,
  createSpace,
  getPage,
  pageTree,
  savePage,
} from "./data";
import { getDb } from "./db";
import { parseBlocks } from "./blocks";
import {
  blocksToMarkdown,
  markdownToBlocks,
  splitFrontmatter,
} from "./markdown";
import { zip, unzip, ZipEntry } from "./zip";
import { slugify } from "./util";

/* ————— export ————— */

type ManifestPage = {
  id: string;
  parentId: string | null;
  slug: string;
  title: string;
  position: number;
  published: boolean;
  blocks: unknown[];
};

export function pageToMarkdown(pageId: string): string | null {
  const page = getPage(pageId);
  if (!page) return null;
  const blocks = parseBlocks(page.content);
  const front = [
    "---",
    `title: ${JSON.stringify(page.title)}`,
    `slug: ${page.slug}`,
    `published: ${page.published === 1}`,
    "---",
    "",
  ].join("\n");
  return front + blocksToMarkdown(blocks) + "\n";
}

export function exportSpaceZip(space: Space): Buffer {
  const tree = pageTree(space.id, false);
  const db = getDb();
  const entries: ZipEntry[] = [];
  const manifestPages: ManifestPage[] = [];
  const root = space.slug;

  const walk = (nodes: TreeNode[], dir: string) => {
    nodes.forEach((n, i) => {
      const row = db
        .prepare("SELECT content FROM pages WHERE id = ?")
        .get(n.id) as { content: string };
      const blocks = parseBlocks(row.content);
      manifestPages.push({
        id: n.id,
        parentId: n.parent_id,
        slug: n.slug,
        title: n.title,
        position: n.position,
        published: n.published === 1,
        blocks,
      });
      const md =
        [
          "---",
          `title: ${JSON.stringify(n.title)}`,
          `slug: ${n.slug}`,
          `published: ${n.published === 1}`,
          "---",
          "",
        ].join("\n") +
        blocksToMarkdown(blocks) +
        "\n";
      const prefix = `${String(i + 1).padStart(2, "0")}-${n.slug}`;
      if (n.children.length) {
        entries.push({
          name: `${dir}/${prefix}/index.md`,
          data: Buffer.from(md, "utf8"),
        });
        walk(n.children, `${dir}/${prefix}`);
      } else {
        entries.push({
          name: `${dir}/${prefix}.md`,
          data: Buffer.from(md, "utf8"),
        });
      }
    });
  };
  walk(tree, root);

  const manifest = {
    octavo: 1,
    exported_at: new Date().toISOString(),
    space: {
      name: space.name,
      slug: space.slug,
      description: space.description,
      kind: space.kind,
      visibility: space.visibility,
    },
    pages: manifestPages,
  };
  entries.unshift({
    name: `${root}/octavo.json`,
    data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
  });
  return zip(entries);
}

/* ————— import ————— */

export type ImportResult = { spaceSlug: string; pages: number };

type Manifest = {
  octavo: number;
  space: {
    name: string;
    description?: string;
    kind?: string;
    visibility?: string;
  };
  pages: ManifestPage[];
};

export function importManifest(manifest: Manifest, nameOverride?: string): ImportResult {
  const space = createSpace({
    name: nameOverride?.trim() || manifest.space.name || "Imported space",
    description: manifest.space.description ?? "",
    kind: manifest.space.kind ?? "docs",
    visibility: "private",
  });
  const idMap = new Map<string, string>();
  const pages = [...manifest.pages].sort((a, b) => a.position - b.position);
  // Parents were exported before children isn't guaranteed — loop until placed.
  let remaining = pages;
  let guard = 0;
  while (remaining.length && guard++ < 50) {
    const next: ManifestPage[] = [];
    for (const p of remaining) {
      const parentNew = p.parentId ? idMap.get(p.parentId) : null;
      if (p.parentId && !parentNew) {
        next.push(p);
        continue;
      }
      const created = createPage({
        spaceId: space.id,
        parentId: parentNew ?? null,
        title: p.title || "Untitled",
        content: JSON.stringify(Array.isArray(p.blocks) ? p.blocks : []),
      });
      if (p.published) savePage(created.id, { published: true });
      idMap.set(p.id, created.id);
    }
    if (next.length === remaining.length) {
      // Orphaned parents — attach the rest at root rather than dropping them.
      for (const p of next) {
        const created = createPage({
          spaceId: space.id,
          parentId: null,
          title: p.title || "Untitled",
          content: JSON.stringify(Array.isArray(p.blocks) ? p.blocks : []),
        });
        if (p.published) savePage(created.id, { published: true });
        idMap.set(p.id, created.id);
      }
      remaining = [];
      break;
    }
    remaining = next;
  }
  return { spaceSlug: space.slug, pages: idMap.size };
}

function titleFrom(meta: Record<string, string>, body: string, fallback: string) {
  if (meta.title) {
    try {
      return JSON.parse(meta.title);
    } catch {
      return meta.title;
    }
  }
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return fallback;
}

const cleanSegment = (s: string) => s.replace(/^\d+[-_.]/, "").replace(/\.md$/i, "");

export function importMarkdownEntries(
  entries: ZipEntry[],
  nameOverride?: string
): ImportResult {
  const mdFiles = entries
    .filter((e) => e.name.toLowerCase().endsWith(".md"))
    .filter((e) => !e.name.split("/").some((seg) => seg.startsWith(".")));
  if (!mdFiles.length) throw new Error("no markdown files found");

  // Strip a common root directory if every file shares one.
  const parts = mdFiles.map((e) => e.name.split("/"));
  let rootName = "";
  if (parts.every((p) => p.length > 1 && p[0] === parts[0][0])) {
    rootName = parts[0][0];
    for (const p of parts) p.shift();
  }

  const space = createSpace({
    name:
      nameOverride?.trim() ||
      cleanSegment(rootName) ||
      "Imported space",
    visibility: "private",
  });

  // Sort so folders' index.md come before their children, and files in order.
  const files = mdFiles
    .map((e, i) => ({ path: parts[i].join("/"), data: e.data }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const dirParent = new Map<string, string | null>(); // dir path -> page id
  dirParent.set("", null);
  let count = 0;

  for (const f of files) {
    const segs = f.path.split("/");
    const fileName = segs.pop()!;
    const dir = segs.join("/");

    // Ensure ancestor dirs exist as container pages (if no index.md created them).
    let acc = "";
    for (const seg of segs) {
      const next = acc ? `${acc}/${seg}` : seg;
      if (!dirParent.has(next)) {
        const holder = createPage({
          spaceId: space.id,
          parentId: dirParent.get(acc) ?? null,
          title: cleanSegment(seg).replace(/[-_]/g, " "),
        });
        dirParent.set(next, holder.id);
        count++;
      }
      acc = next;
    }

    const [meta, body] = splitFrontmatter(f.data.toString("utf8"));
    const isIndex = /^(index|readme)\.md$/i.test(fileName);
    const fallback = cleanSegment(isIndex ? segs[segs.length - 1] ?? "Home" : fileName)
      .replace(/[-_]/g, " ");
    const title = titleFrom(meta, body, fallback || "Untitled");
    // Drop a leading H1 that duplicates the title.
    const bodyNoH1 = body.replace(/^#\s+.+\n+/, (m) =>
      m.slice(2).trim() === title ? "" : m
    );
    const blocks = markdownToBlocks(bodyNoH1);

    if (isIndex && dir !== "") {
      // This file IS the container page for its directory.
      const existing = dirParent.get(dir);
      if (existing) {
        savePage(existing, {
          title,
          content: JSON.stringify(blocks),
          published: meta.published !== "false",
        });
        continue;
      }
    }
    const page = createPage({
      spaceId: space.id,
      parentId: dirParent.get(dir) ?? null,
      title,
      content: JSON.stringify(blocks),
    });
    savePage(page.id, { published: meta.published !== "false" });
    if (isIndex) dirParent.set(dir, page.id);
    count++;
  }

  return { spaceSlug: space.slug, pages: count };
}

export function importUpload(
  fileName: string,
  data: Buffer,
  nameOverride?: string
): ImportResult {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".zip")) {
    const entries = unzip(data);
    const manifestEntry = entries.find((e) => e.name.endsWith("octavo.json"));
    if (manifestEntry) {
      const manifest = JSON.parse(manifestEntry.data.toString("utf8"));
      if (manifest?.octavo === 1 && Array.isArray(manifest.pages)) {
        return importManifest(manifest, nameOverride);
      }
    }
    return importMarkdownEntries(entries, nameOverride);
  }
  if (lower.endsWith(".json")) {
    const manifest = JSON.parse(data.toString("utf8"));
    if (manifest?.octavo === 1 && Array.isArray(manifest.pages)) {
      return importManifest(manifest, nameOverride);
    }
    throw new Error("not an Octavo export");
  }
  if (lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".txt")) {
    const base = cleanSegment(fileName.replace(/\.(markdown|txt)$/i, ".md"));
    return importMarkdownEntries(
      [{ name: `${slugify(base)}.md`, data }],
      nameOverride || base.replace(/[-_]/g, " ")
    );
  }
  throw new Error("unsupported file type — use .zip, .md, or an octavo.json");
}
