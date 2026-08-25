import "server-only";
import fs from "node:fs";
import path from "node:path";
import { UPLOADS_DIR } from "./db";
import { newId } from "./util";
import { htmlToBlocks, type ImportedBlock } from "./html-blocks";
import { child, elements, findAll, parseXml, textOf, type XmlNode } from "./xml";
import type { ZipEntry } from "./zip";

/**
 * Confluence space export (XML) → Octavo.
 *
 * This importer exists because of a date: Atlassian's Data Center door
 * closes in March 2026, and everyone still self-hosting Confluence has to go
 * somewhere. The XML space export is the complete one — every page, the
 * tree, the attachments — and it is the format people already have on disk,
 * because it is what Confluence's own backup produces.
 *
 * entities.xml is a Hibernate object graph, not a document: thousands of
 * <object class="…"> elements referencing each other by numeric id. The walk
 * is three passes — collect, link, convert — because the graph arrives in no
 * useful order.
 *
 * What is deliberately dropped: historical versions (Octavo starts its own
 * history at import), permissions (they do not map — the operator assigns
 * membership here), comments (Confluence comments are threads on a whole
 * page; carrying them as content would freeze a conversation into prose),
 * and blog posts' social trappings. Every drop is by omission of chrome,
 * never of a page's words.
 */

type ConfPage = {
  id: string;
  title: string;
  parentId: string | null;
  position: number;
  bodyId: string | null;
  status: string;
  isBlog: boolean;
};

type ConfAttachment = {
  id: string;
  title: string;
  pageId: string;
  version: number;
};

export type ConfluenceSpace = {
  name: string;
  key: string;
  description: string;
  pages: {
    title: string;
    parentTitle: string | null;
    position: number;
    blocks: ImportedBlock[];
  }[];
  attachmentsSaved: number;
  attachmentsMissing: string[];
  pagesSkipped: number;
};

function propOf(obj: XmlNode, name: string): XmlNode | undefined {
  return elements(obj).find(
    (c) =>
      (c.tag === "property" || c.tag === "collection") && c.attrs.name === name
  );
}

function propText(obj: XmlNode, name: string): string {
  return textOf(propOf(obj, name)).trim();
}

/** The numeric id inside a reference property or the object's own <id>. */
function idOf(node: XmlNode | undefined): string {
  if (!node) return "";
  const id = child(node, "id");
  return (id ? textOf(id) : textOf(node)).trim();
}

/**
 * Read the whole export. `entries` is the unzipped archive; attachment
 * binaries live at attachments/<pageId>/<attachmentId>/<version>.
 */
export function readConfluenceExport(entries: ZipEntry[]): ConfluenceSpace {
  const entitiesEntry = entries.find((e) => e.name.endsWith("entities.xml"));
  if (!entitiesEntry) throw new Error("entities.xml missing — not a Confluence XML export");

  const objects = findAll(parseXml(entitiesEntry.data.toString("utf8")), "object");

  let spaceName = "";
  let spaceKey = "";
  let spaceDescription = "";
  const pages = new Map<string, ConfPage>();
  const bodies = new Map<string, string>(); // bodyContent id -> storage xhtml
  const bodyByPage = new Map<string, string>(); // page id -> body id
  const attachments: ConfAttachment[] = [];

  // Pass 1: collect every object we care about.
  for (const obj of objects) {
    const cls = obj.attrs.class ?? "";
    if (cls === "Space") {
      spaceName = propText(obj, "name") || spaceName;
      spaceKey = propText(obj, "key") || spaceKey;
      const desc = propOf(obj, "description");
      if (desc) spaceDescription = textOf(desc).trim().slice(0, 300);
      continue;
    }
    if (cls === "Page" || cls === "BlogPost") {
      // A historical version carries originalVersion pointing at the live
      // page; the live page never does. Trash carries a status.
      const historical = Boolean(propOf(obj, "originalVersion"));
      const page: ConfPage = {
        id: idOf(obj),
        title: propText(obj, "title") || "Untitled",
        parentId: idOf(propOf(obj, "parent")) || null,
        position: Number(propText(obj, "position")) || 0,
        bodyId: null,
        status: propText(obj, "contentStatus") || "current",
        isBlog: cls === "BlogPost",
      };
      if (!historical && page.id) pages.set(page.id, page);
      // The body ids may be listed on the page itself.
      const coll = propOf(obj, "bodyContents");
      if (coll && !historical) {
        const first = findAll(coll.children, "element")[0] ?? findAll(coll.children, "id")[0];
        if (first) bodyByPage.set(page.id, idOf(first) || textOf(first).trim());
      }
      continue;
    }
    if (cls === "BodyContent") {
      const id = idOf(obj);
      const body = propText(obj, "body");
      const contentRef = idOf(propOf(obj, "content"));
      if (id) bodies.set(id, body);
      // …or the body may point back at its page. Either direction suffices.
      if (contentRef && id) {
        if (!bodyByPage.has(contentRef)) bodyByPage.set(contentRef, id);
      }
      continue;
    }
    if (cls === "Attachment") {
      const a: ConfAttachment = {
        id: idOf(obj),
        title: propText(obj, "title") || propText(obj, "fileName"),
        pageId:
          idOf(propOf(obj, "containerContent")) || idOf(propOf(obj, "content")),
        version: Number(propText(obj, "version")) || 1,
      };
      if (a.id && a.title) attachments.push(a);
    }
  }

  // Pass 2: materialise attachments into uploads, newest version of each.
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const attachmentUrl = new Map<string, string>(); // "<pageId>/<filename>" and "<filename>"
  const missing: string[] = [];
  let saved = 0;
  for (const a of attachments) {
    const entry =
      entries.find((e) => e.name.replace(/\\/g, "/").endsWith(`attachments/${a.pageId}/${a.id}/${a.version}`)) ??
      entries.find((e) => e.name.replace(/\\/g, "/").includes(`attachments/${a.pageId}/${a.id}/`));
    if (!entry) {
      missing.push(a.title);
      continue;
    }
    const ext = path.extname(a.title) || "";
    const stored = `${newId()}${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, stored), entry.data);
    const url = `/api/files/${stored}`;
    attachmentUrl.set(`${a.pageId}/${a.title}`, url);
    if (!attachmentUrl.has(a.title)) attachmentUrl.set(a.title, url);
    saved++;
  }

  // Pass 3: convert each live page's storage-format body.
  const out: ConfluenceSpace = {
    name: spaceName || spaceKey || "Confluence import",
    key: spaceKey,
    description: spaceDescription,
    pages: [],
    attachmentsSaved: saved,
    attachmentsMissing: missing,
    pagesSkipped: 0,
  };

  for (const page of pages.values()) {
    if (page.status && page.status !== "current") {
      out.pagesSkipped++;
      continue;
    }
    const bodyId = bodyByPage.get(page.id);
    const storage = bodyId ? bodies.get(bodyId) ?? "" : "";
    const resolve = (filename: string) =>
      attachmentUrl.get(`${page.id}/${filename}`) ?? attachmentUrl.get(filename) ?? null;
    const blocks = htmlToBlocks(storage, resolve);
    const parent = page.parentId ? pages.get(page.parentId) : undefined;
    out.pages.push({
      title: page.isBlog ? `Blog — ${page.title}` : page.title,
      parentTitle: parent && !parent.isBlog ? parent.title : null,
      position: page.position,
      blocks,
    });
  }

  // Stable order: parents before children, then by Confluence's own position.
  out.pages.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
  return out;
}

/** Whether a zip looks like a Confluence XML export. */
export function looksLikeConfluence(entries: ZipEntry[]): boolean {
  return entries.some((e) => e.name.endsWith("entities.xml"));
}
