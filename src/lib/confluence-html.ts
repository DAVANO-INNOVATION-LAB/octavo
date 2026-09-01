/**
 * Reading a Confluence *HTML* space export.
 *
 * The XML export is the good one — it carries the page tree, versions and
 * attachments as data. Plenty of people cannot produce it: exporting XML
 * needs space-admin rights, and on Cloud it is often simply not offered. What
 * they can produce is the HTML export, and telling someone their only
 * available export is unsupported is telling them their data is not portable.
 *
 * So this reads what the HTML export actually contains: one file per page,
 * the tree recoverable from index.html, and attachments beside them.
 */

import { htmlToBlocks, type ImportedBlock } from "./html-blocks";
import { findAll, parseXml, textOf, type XmlNode } from "./xml";

export type ConfluenceHtmlPage = {
  /** The export's own filename, which is how pages link to each other. */
  file: string;
  title: string;
  /** Parent's filename, or "" for a top-level page. */
  parentFile: string;
  blocks: ImportedBlock[];
};

export type ConfluenceHtmlSpace = {
  name: string;
  pages: ConfluenceHtmlPage[];
};

type Entry = { name: string; data: Buffer };

/**
 * An HTML export, and not just any folder of HTML.
 *
 * Confluence stamps every exported page with the same wrapper, so the marker
 * is that wrapper rather than the mere presence of .html files — otherwise a
 * saved web page or a static site would be dragged down this path.
 */
export function looksLikeConfluenceHtml(entries: Entry[]): boolean {
  const html = entries.filter((e) => /\.html?$/i.test(e.name));
  if (html.length === 0) return false;
  const sample = html.slice(0, 12);
  return sample.some((e) => {
    const head = e.data.subarray(0, 4000).toString("utf8");
    return (
      /id="main-content"/.test(head) ||
      /class="[^"]*confluence[^"]*"/i.test(head) ||
      /<meta[^>]+name="confluence/i.test(head)
    );
  });
}

type Forest = (XmlNode | string)[];

const first = (nodes: Forest, tag: string): XmlNode | null => findAll(nodes, tag)[0] ?? null;

/** The page body Confluence wraps its content in, falling back sensibly. */
function bodyOf(forest: Forest): XmlNode | null {
  return (
    findWhere(forest, (n) => n.attrs?.id === "main-content") ??
    findWhere(forest, (n) => (n.attrs?.class ?? "").split(/\s+/).includes("wiki-content")) ??
    first(forest, "main") ??
    first(forest, "body")
  );
}

function findWhere(nodes: Forest, ok: (n: XmlNode) => boolean): XmlNode | null {
  for (const n of nodes) {
    if (typeof n === "string") continue;
    if (ok(n)) return n;
    const inner = findWhere(n.children, ok);
    if (inner) return inner;
  }
  return null;
}

/** Confluence puts the page title in an <h1 id="title-heading"> or the <title>. */
function titleOf(forest: Forest, fallback: string): string {
  const h1 = findWhere(forest, (n) => n.attrs?.id === "title-heading") ?? first(forest, "h1");
  const fromH1 = h1 ? textOf(h1).trim() : "";
  if (fromH1) return fromH1;
  const raw = textOf(first(forest, "title") ?? undefined).trim();
  // "Space Name : Page Title" is the shape Confluence writes.
  const cut = raw.includes(" : ") ? raw.slice(raw.indexOf(" : ") + 3) : raw;
  return cut.trim() || fallback;
}

/**
 * The tree, taken from index.html.
 *
 * Confluence's index lists pages as a nested <ul>, and that nesting is the
 * only place the hierarchy survives in an HTML export — the pages themselves
 * only carry a breadcrumb of titles, which duplicates break. Missing or
 * unreadable, every page lands at the top level, which is recoverable by hand
 * in a way that a wrong tree is not.
 */
export function readHtmlIndex(indexHtml: string): Map<string, string> {
  const parent = new Map<string, string>();
  const forest = parseXml(indexHtml);
  const walk = (nodes: Forest, currentParent: string) => {
    for (const n of nodes) {
      if (typeof n === "string") continue;
      if (n.tag === "li") {
        const href = hrefOf(first([n], "a"));
        if (href) {
          parent.set(href, currentParent);
          // Nested lists inside this <li> are this page's children.
          for (const c of n.children) {
            if (typeof c !== "string" && (c.tag === "ul" || c.tag === "ol"))
              walk(c.children, href);
          }
          continue;
        }
      }
      walk(n.children, currentParent);
    }
  };
  walk(forest, "");
  return parent;
}

function hrefOf(a: XmlNode | null): string {
  const href = a?.attrs?.href;
  if (typeof href !== "string") return "";
  if (/^(https?:|mailto:|#)/i.test(href)) return "";
  const clean = href.split("#")[0].split("?")[0];
  return /\.html?$/i.test(clean) ? clean.replace(/^\.\//, "") : "";
}

/**
 * Read the whole export.
 *
 * `resolve` turns an attachment path from the export into a URL the imported
 * page can point at; the caller owns writing those files, because this module
 * stays pure enough to test.
 */
export function readConfluenceHtmlExport(
  entries: Entry[],
  resolve?: (path: string) => string | null
): ConfluenceHtmlSpace {
  const pageFiles = entries.filter(
    (e) =>
      /\.html?$/i.test(e.name) &&
      !/(^|\/)index\.html?$/i.test(e.name) &&
      !e.name.split("/").some((s) => s.startsWith("."))
  );

  const index = entries.find((e) => /(^|\/)index\.html?$/i.test(e.name));
  const parentOf = index ? readHtmlIndex(index.data.toString("utf8")) : new Map<string, string>();

  const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const known = new Set(pageFiles.map((e) => nameOf(e.name)));

  const pages: ConfluenceHtmlPage[] = [];
  for (const e of pageFiles) {
    const html = e.data.toString("utf8");
    const forest = parseXml(html);
    const file = nameOf(e.name);
    const body = bodyOf(forest);
    const blocks: ImportedBlock[] = [];
    if (body) for (const c of body.children) blocksInto(c, blocks, resolve);
    const rawParent = parentOf.get(file) ?? "";
    pages.push({
      file,
      title: titleOf(forest, file.replace(/\.html?$/i, "")),
      // A parent outside the export would orphan the page; treat it as a root.
      parentFile: known.has(rawParent) ? rawParent : "",
      blocks,
    });
  }

  const spaceName =
    (index && spaceNameFrom(index.data.toString("utf8"))) ||
    pages[0]?.title ||
    "Imported space";
  return { name: spaceName, pages };
}

function blocksInto(
  node: XmlNode | string,
  out: ImportedBlock[],
  resolve?: (path: string) => string | null
) {
  // htmlToBlocks owns every conversion rule; this only re-serialises one node
  // so there is exactly one implementation of "what does this markup mean".
  for (const b of htmlToBlocks(serialise(node), resolve ? (f) => resolve(f) : undefined))
    out.push(b);
}

function serialise(n: XmlNode | string): string {
  if (typeof n === "string") return escapeText(n);
  const attrs = Object.entries(n.attrs)
    .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, "&quot;")}"`)
    .join("");
  return `<${n.tag}${attrs}>${n.children.map(serialise).join("")}</${n.tag}>`;
}

function escapeText(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function spaceNameFrom(indexHtml: string): string {
  const forest = parseXml(indexHtml);
  const raw = textOf(first(forest, "title") ?? undefined).trim();
  if (!raw) return "";
  // "Space Name : Index" or just the space name.
  return (raw.includes(" : ") ? raw.slice(0, raw.indexOf(" : ")) : raw).trim();
}
