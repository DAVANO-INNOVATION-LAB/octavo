import "server-only";
import { looksLikeConfluence, readConfluenceExport } from "./confluence";
import { looksLikeConfluenceHtml, readConfluenceHtmlExport } from "./confluence-html";
import {
  cleanNotionPath,
  looksLikeNotion,
  notionId,
  rewriteNotionLinks,
  splitNotionPage,
} from "./notion";
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
import fs from "node:fs";
import path from "node:path";
import { UPLOADS_DIR } from "./db";
import { newId, slugify } from "./util";

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

  // A Notion export is markdown, so it lands here — but with a 32-hex id
  // welded onto every name and every internal link pointing at those names.
  // Imported as-is it arrives with unreadable titles and broken links, which
  // is worse than refusing it, because it looks like it worked.
  const notion = looksLikeNotion(entries.map((e) => e.name));
  const notionIdByPath = new Map<string, string>();
  if (notion) {
    for (const e of mdFiles) {
      const id = notionId(e.name);
      if (id) notionIdByPath.set(e.name, id);
    }
  }

  // Strip a common root directory if every file shares one.
  const parts = mdFiles.map((e) => (notion ? cleanNotionPath(e.name) : e.name).split("/"));
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
    .map((e, i) => ({
      path: parts[i].join("/"),
      data: e.data,
      notionId: notionIdByPath.get(e.name) ?? "",
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  // Notion links by exported filename, so the id is the join key. The map has
  // to be complete before any body is converted, or a page would only ever
  // link to pages that happened to import before it.
  const notionHref = new Map<string, string>();
  if (notion) {
    for (const f of files) {
      if (!f.notionId) continue;
      const stem = f.path.replace(/\.md$/i, "");
      const name = stem.split("/").pop() ?? stem;
      notionHref.set(f.notionId, `/${space.slug}/${slugify(name)}`);
    }
  }

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

    let raw = f.data.toString("utf8");
    let notionProps: { name: string; value: string }[] = [];
    if (notion) {
      raw = rewriteNotionLinks(raw, notionHref);
      const split = splitNotionPage(raw);
      notionProps = split.properties;
      // Notion writes the title as an H1; keep it so titleFrom still sees it.
      raw = split.title ? `# ${split.title}\n\n${split.body}` : split.body;
    }
    const [meta, body] = splitFrontmatter(raw);
    const isIndex = /^(index|readme)\.md$/i.test(fileName);
    const fallback = cleanSegment(isIndex ? segs[segs.length - 1] ?? "Home" : fileName)
      .replace(/[-_]/g, " ");
    const title = titleFrom(meta, body, fallback || "Untitled");
    // Drop a leading H1 that duplicates the title.
    const bodyNoH1 = body.replace(/^#\s+.+\n+/, (m) =>
      m.slice(2).trim() === title ? "" : m
    );
    const blocks = markdownToBlocks(bodyNoH1);
    // Database properties are real content — owner, status, dates — but read
    // as a broken paragraph inline. A table keeps them, and keeps them apart.
    if (notionProps.length > 0) {
      blocks.unshift({
        id: newId(),
        type: "table",
        props: {},
        content: {
          type: "tableContent",
          rows: notionProps.map((pr) => ({
            cells: [
              [{ type: "text", text: pr.name, styles: { bold: true } }],
              [{ type: "text", text: pr.value, styles: {} }],
            ],
          })),
        },
        children: [],
      } as unknown as (typeof blocks)[number]);
    }

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

/**
 * A Confluence XML space export becomes one Octavo space, private until the
 * operator says otherwise. Pages keep their tree and order; attachments land
 * in uploads; everything imports published, because in Confluence it was.
 */
export function importConfluence(entries: ZipEntry[], nameOverride?: string): ImportResult {
  const conf = readConfluenceExport(entries);
  const space = createSpace({
    name: nameOverride?.trim() || conf.name,
    description: conf.description,
    kind: "docs",
    visibility: "private",
  });
  const byTitle = new Map<string, string>();
  let remaining = conf.pages;
  let guard = 0;
  while (remaining.length && guard++ < 50) {
    const next: typeof remaining = [];
    for (const p of remaining) {
      const parentNew = p.parentTitle ? byTitle.get(p.parentTitle) : null;
      if (p.parentTitle && !parentNew) {
        next.push(p);
        continue;
      }
      const created = createPage({
        spaceId: space.id,
        parentId: parentNew ?? null,
        title: p.title,
        content: JSON.stringify(p.blocks),
      });
      savePage(created.id, { published: true });
      byTitle.set(p.title, created.id);
    }
    if (next.length === remaining.length) {
      for (const p of next) {
        const created = createPage({
          spaceId: space.id,
          parentId: null,
          title: p.title,
          content: JSON.stringify(p.blocks),
        });
        savePage(created.id, { published: true });
        byTitle.set(p.title, created.id);
      }
      break;
    }
    remaining = next;
  }
  return { spaceSlug: space.slug, pages: byTitle.size };
}

/**
 * A Confluence HTML export becomes one space.
 *
 * The tree comes from index.html and nothing else: the pages themselves carry
 * only a breadcrumb of titles, which two pages sharing a name break silently.
 * With no index, everything lands at the top level — a flat tree someone can
 * fix in an afternoon, rather than a wrong one they may never notice.
 */
export function importConfluenceHtml(
  entries: ZipEntry[],
  nameOverride?: string
): ImportResult {
  const written = new Map<string, string>();
  const resolve = (file: string): string | null => {
    const want = file.split("/").pop() ?? file;
    if (written.has(want)) return written.get(want)!;
    const hit = entries.find((e) => (e.name.split("/").pop() ?? "") === want && !/\.html?$/i.test(e.name));
    if (!hit) return null;
    const ext = path.extname(want).toLowerCase();
    const name = `${newId()}${ext}`;
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOADS_DIR, name), hit.data);
    const url = `/api/files/${name}`;
    written.set(want, url);
    return url;
  };

  const exp = readConfluenceHtmlExport(entries, resolve);
  if (exp.pages.length === 0) throw new Error("no pages found in this HTML export");
  const space = createSpace({
    name: nameOverride?.trim() || exp.name,
    kind: "docs",
    visibility: "private",
  });

  const byFile = new Map<string, string>();
  let remaining = exp.pages;
  let guard = 0;
  while (remaining.length && guard++ < 50) {
    const next: typeof remaining = [];
    for (const p of remaining) {
      const parentId = p.parentFile ? byFile.get(p.parentFile) : null;
      if (p.parentFile && !parentId) { next.push(p); continue; }
      const created = createPage({
        spaceId: space.id,
        parentId: parentId ?? null,
        title: p.title,
        content: JSON.stringify(p.blocks),
      });
      savePage(created.id, { published: true });
      byFile.set(p.file, created.id);
    }
    // A cycle in the index would loop forever; land the rest at the top.
    if (next.length === remaining.length) {
      for (const p of next) {
        const created = createPage({
          spaceId: space.id, parentId: null, title: p.title,
          content: JSON.stringify(p.blocks),
        });
        savePage(created.id, { published: true });
        byFile.set(p.file, created.id);
      }
      break;
    }
    remaining = next;
  }
  return { spaceSlug: space.slug, pages: byFile.size };
}

export function importUpload(
  fileName: string,
  data: Buffer,
  nameOverride?: string
): ImportResult {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".zip")) {
    const entries = unzip(data);
    if (looksLikeConfluence(entries)) return importConfluence(entries, nameOverride);
    if (looksLikeConfluenceHtml(entries)) return importConfluenceHtml(entries, nameOverride);
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
  if (lower.endsWith(".ipynb")) {
    return importNotebook(fileName, data, nameOverride);
  }
  if (lower.endsWith(".docx")) {
    return importDocx(fileName, data, nameOverride);
  }
  if (lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".txt")) {
    const base = cleanSegment(fileName.replace(/\.(markdown|txt)$/i, ".md"));
    return importMarkdownEntries(
      [{ name: `${slugify(base)}.md`, data }],
      nameOverride || base.replace(/[-_]/g, " ")
    );
  }
  throw new Error("unsupported file type — use .zip, .md, .ipynb, .docx, or an octavo.json");
}

// ---- Jupyter notebooks ----

type NotebookCell = {
  cell_type?: string;
  source?: string | string[];
  outputs?: {
    output_type?: string;
    text?: string | string[];
    data?: Record<string, string | string[]>;
  }[];
};

const joinSource = (src: string | string[] | undefined): string =>
  Array.isArray(src) ? src.join("") : (src ?? "");

/**
 * .ipynb → a page, keeping cell order, code, and outputs.
 *
 * Markdown cells go through the same converter as any markdown import; code
 * cells become code blocks; text outputs follow their cell as a plain code
 * block, and image outputs are written into uploads and embedded. Execution
 * counts are dropped — they describe one session on someone else's machine.
 */
export function importNotebook(
  fileName: string,
  data: Buffer,
  nameOverride?: string
): ImportResult {
  let nb: {
    cells?: NotebookCell[];
    metadata?: { language_info?: { name?: string } };
  };
  try {
    nb = JSON.parse(data.toString("utf8"));
  } catch {
    throw new Error("not a Jupyter notebook — the file is not valid JSON");
  }
  if (!Array.isArray(nb.cells)) throw new Error("not a Jupyter notebook — no cells");

  const language = nb.metadata?.language_info?.name ?? "python";
  const blocks: ReturnType<typeof markdownToBlocks> = [];

  for (const cell of nb.cells) {
    const source = joinSource(cell.source);
    if (cell.cell_type === "markdown" && source.trim()) {
      blocks.push(...markdownToBlocks(source));
      continue;
    }
    if (cell.cell_type !== "code") continue;
    if (source.trim()) {
      blocks.push({
        id: newId(),
        type: "codeBlock",
        props: { language },
        content: [{ type: "text", text: source, styles: {} }],
        children: [],
      });
    }
    for (const out of cell.outputs ?? []) {
      const textOut =
        joinSource(out.text) ||
        joinSource(out.data?.["text/plain"] as string | string[] | undefined);
      const png = out.data?.["image/png"];
      if (png) {
        const bytes = Buffer.from(joinSource(png), "base64");
        const name = `${newId()}.png`;
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });
        fs.writeFileSync(path.join(UPLOADS_DIR, name), bytes);
        blocks.push({
          id: newId(),
          type: "image",
          props: { url: `/api/files/${name}`, caption: "" },
          content: [],
          children: [],
        });
      } else if (textOut.trim()) {
        blocks.push({
          id: newId(),
          type: "codeBlock",
          props: { language: "text" },
          content: [{ type: "text", text: textOut.trimEnd(), styles: {} }],
          children: [],
        });
      }
    }
  }

  const title =
    nameOverride?.trim() ||
    cleanSegment(fileName.replace(/\.ipynb$/i, "")).replace(/[-_]/g, " ");
  return importSinglePage(title, blocks);
}

// ---- Word documents ----

/**
 * .docx → a page. Paragraphs, headings and list items survive; the rest of
 * Word's vocabulary is deliberately flattened to text rather than half-kept.
 * A docx is a zip of XML, and the one file that matters is word/document.xml.
 */
export function importDocx(
  fileName: string,
  data: Buffer,
  nameOverride?: string
): ImportResult {
  const entries = unzip(data);
  const doc = entries.find((e) => e.name === "word/document.xml");
  if (!doc) throw new Error("not a Word document — word/document.xml missing");
  const xml = doc.data.toString("utf8");

  const decode = (t: string) =>
    t
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");

  const blocks: ReturnType<typeof markdownToBlocks> = [];
  // Paragraph by paragraph; inside each, concatenate every text run.
  for (const [, para] of xml.matchAll(/<w:p[ >]([\s\S]*?)<\/w:p>/g)) {
    const runs = [...para.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((m) => decode(m[1]))
      .join("");
    const textContent = runs.trim();
    if (!textContent) continue;

    const styleMatch = para.match(/<w:pStyle w:val="([^"]+)"/);
    const style = styleMatch?.[1] ?? "";
    const headingLevel = /^Heading([1-6])$/.exec(style)?.[1];
    const isListItem = /<w:numPr>/.test(para);

    blocks.push({
      id: newId(),
      type: headingLevel ? "heading" : isListItem ? "bulletListItem" : "paragraph",
      props: headingLevel ? { level: Math.min(3, Number(headingLevel)) } : {},
      content: [{ type: "text", text: textContent, styles: {} }],
      children: [],
    });
  }
  if (blocks.length === 0) throw new Error("the document contains no readable text");

  const title =
    nameOverride?.trim() ||
    cleanSegment(fileName.replace(/\.docx$/i, "")).replace(/[-_]/g, " ");
  return importSinglePage(title, blocks);
}

/** One page in one new space — the shape single-file imports share. */
function importSinglePage(
  title: string,
  blocks: ReturnType<typeof markdownToBlocks>
): ImportResult {
  const space = createSpace({ name: title, kind: "doc" });
  const page = createPage({
    spaceId: space.id,
    title,
    content: JSON.stringify(blocks),
  });
  savePage(page.id, { published: true });
  return { spaceSlug: space.slug, pages: 1 };
}
