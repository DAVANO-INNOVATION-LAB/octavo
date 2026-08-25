import { newId } from "./util";
import { elements, parseXml, textOf, type XmlNode } from "./xml";

/**
 * Markup → Octavo blocks. One converter for every door content arrives
 * through: a Confluence storage-format body, a fetched web page, an HTML
 * export. The Confluence-specific vocabulary (<ac:structured-macro>,
 * <ri:attachment>) is handled here too rather than in a subclass — the tags
 * only ever mean one thing, and a second dialect layer would be structure
 * for its own sake.
 *
 * The rule throughout: rescue the content, drop the chrome. Unknown elements
 * contribute their text; unknown macros contribute their rich body; nothing
 * throws. An importer that refuses a page over markup it has not met is
 * worse than one that imports the words and loses a decoration.
 */

export type Inline = {
  type: "text" | "link";
  text?: string;
  href?: string;
  content?: Inline[];
  styles?: Record<string, boolean | string>;
};

export type ImportedBlock = {
  id: string;
  type: string;
  props: Record<string, string | number | boolean>;
  content?: Inline[] | { type: "tableContent"; rows: { cells: Inline[][] }[] };
  children: ImportedBlock[];
};

/** How the converter asks its caller to materialise an attachment. Returns
 *  the URL to embed, or null when the file is not in the export. */
export type AttachmentResolver = (filename: string) => string | null;

const text = (t: string, styles: Record<string, boolean | string> = {}): Inline => ({
  type: "text",
  text: t,
  styles,
});

const block = (
  type: string,
  props: Record<string, string | number | boolean> = {},
  content?: ImportedBlock["content"]
): ImportedBlock => ({ id: newId(), type, props, content, children: [] });

const HEADINGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 3, h5: 3, h6: 3 };
const SKIP = new Set([
  "head", "nav", "footer", "aside", "form", "button", "iframe", "svg",
  "noscript", "template", "figcaption", // handled with its figure
  "ac:placeholder", // authoring hints, not content
]);
const MACRO_TONE: Record<string, string> = {
  info: "info", tip: "success", note: "warning", warning: "danger",
  panel: "info",
};

/** Inline markup beneath a node, styles accumulated on the way down. */
function inlineOf(
  node: XmlNode | string,
  styles: Record<string, boolean | string> = {},
  resolve?: AttachmentResolver
): Inline[] {
  if (typeof node === "string") {
    const t = node.replace(/\s+/g, " ");
    return t ? [text(t, { ...styles })] : [];
  }
  switch (node.tag) {
    case "strong":
    case "b":
      return inlineChildren(node, { ...styles, bold: true }, resolve);
    case "em":
    case "i":
      return inlineChildren(node, { ...styles, italic: true }, resolve);
    case "u":
      return inlineChildren(node, { ...styles, underline: true }, resolve);
    case "s":
    case "del":
    case "strike":
      return inlineChildren(node, { ...styles, strike: true }, resolve);
    case "code":
    case "tt":
      return inlineChildren(node, { ...styles, code: true }, resolve);
    case "br":
      return [text(" ")];
    case "a": {
      const href = node.attrs.href ?? "";
      const inner = inlineChildren(node, styles, resolve);
      if (!href) return inner;
      return [{ type: "link", href, content: inner.length ? inner : [text(href)] }];
    }
    case "ac:link": {
      // A link to another Confluence page, by title. The importer slugs
      // titles the same way, so the relative link keeps working after import.
      const target = descendant(node, "ri:page")?.attrs["ri:content-title"] ?? "";
      const label =
        textOf(descendant(node, "ac:plain-text-link-body")) ||
        textOf(descendant(node, "ac:link-body")) ||
        target;
      if (!target) return label ? [text(label, { ...styles })] : [];
      return [{ type: "link", href: `./${slugify(target)}`, content: [text(label || target)] }];
    }
    case "time":
      return [text(node.attrs.datetime ?? textOf(node), { ...styles })];
    case "ac:emoticon":
      return []; // decoration, and this product does not do emoji
    default:
      return inlineChildren(node, styles, resolve);
  }
}

function inlineChildren(
  node: XmlNode,
  styles: Record<string, boolean | string>,
  resolve?: AttachmentResolver
): Inline[] {
  return node.children.flatMap((c) => inlineOf(c, styles, resolve));
}

function descendant(node: XmlNode, tag: string): XmlNode | undefined {
  for (const c of elements(node)) {
    if (c.tag === tag) return c;
    const deep = descendant(c, tag);
    if (deep) return deep;
  }
  return undefined;
}

function slugify(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function macroParam(node: XmlNode, name: string): string {
  for (const p of elements(node)) {
    if (p.tag === "ac:parameter" && p.attrs["ac:name"] === name) return textOf(p).trim();
  }
  return "";
}

/** One element → zero or more blocks. */
function blocksOf(
  node: XmlNode | string,
  out: ImportedBlock[],
  resolve?: AttachmentResolver
): void {
  if (typeof node === "string") {
    const t = node.trim();
    if (t) out.push(block("paragraph", {}, [text(t.replace(/\s+/g, " "))]));
    return;
  }
  const tag = node.tag;
  if (SKIP.has(tag)) return;

  if (HEADINGS[tag]) {
    const inline = inlineChildren(node, {}, resolve);
    if (inline.length) out.push(block("heading", { level: HEADINGS[tag] }, inline));
    return;
  }

  switch (tag) {
    case "p": {
      const inline = inlineChildren(node, {}, resolve).filter(
        (i) => i.type === "link" || (i.text ?? "").trim() !== "" || i.text === " "
      );
      // A paragraph that only wraps an image is the image.
      const img = elements(node).find((c) => c.tag === "img" || c.tag === "ac:image");
      const textLen = inline.map((i) => i.text ?? "").join("").trim().length;
      if (img && textLen === 0) {
        blocksOf(img, out, resolve);
        return;
      }
      if (textLen > 0 || inline.some((i) => i.type === "link"))
        out.push(block("paragraph", {}, inline));
      return;
    }
    case "ul":
    case "ol": {
      const type = tag === "ul" ? "bulletListItem" : "numberedListItem";
      for (const li of elements(node)) {
        if (li.tag !== "li") continue;
        const nested = elements(li).filter((c) => c.tag === "ul" || c.tag === "ol");
        const own = {
          ...li,
          children: li.children.filter((c) => typeof c === "string" || (c.tag !== "ul" && c.tag !== "ol")),
        };
        const item = block(type, {}, inlineChildren(own, {}, resolve));
        for (const sub of nested) {
          const kids: ImportedBlock[] = [];
          blocksOf(sub, kids, resolve);
          item.children.push(...kids);
        }
        out.push(item);
      }
      return;
    }
    case "ac:task-list": {
      for (const task of elements(node)) {
        if (task.tag !== "ac:task") continue;
        const done = textOf(descendant(task, "ac:task-status")).trim() === "complete";
        const body = descendant(task, "ac:task-body");
        out.push(
          block("checkListItem", { checked: done }, body ? inlineChildren(body, {}, resolve) : [])
        );
      }
      return;
    }
    case "pre": {
      const code = textOf(node).replace(/\n$/, "");
      if (code.trim()) out.push(block("codeBlock", { language: "" }, [text(code)]));
      return;
    }
    case "blockquote": {
      out.push(block("quote", {}, inlineChildren(node, {}, resolve)));
      return;
    }
    case "table": {
      const rows: { cells: Inline[][] }[] = [];
      for (const tr of findRows(node)) {
        const cells = elements(tr)
          .filter((c) => c.tag === "td" || c.tag === "th")
          .map((c) => inlineChildren(c, {}, resolve));
        if (cells.length) rows.push({ cells });
      }
      if (rows.length) out.push(block("table", {}, { type: "tableContent", rows }));
      return;
    }
    case "img": {
      const src = node.attrs.src ?? "";
      if (src) out.push(block("image", { url: src, caption: node.attrs.alt ?? "" }));
      return;
    }
    case "ac:image": {
      const attachment = descendant(node, "ri:attachment")?.attrs["ri:filename"];
      const external = descendant(node, "ri:url")?.attrs["ri:value"];
      const caption = node.attrs["ac:alt"] ?? "";
      const url = attachment ? resolve?.(attachment) ?? null : external ?? null;
      if (url) out.push(block("image", { url, caption }));
      else if (attachment)
        out.push(block("paragraph", {}, [text(`[missing attachment: ${attachment}]`)]));
      return;
    }
    case "ac:structured-macro":
    case "ac:macro": {
      const name = node.attrs["ac:name"] ?? "";
      if (name === "code") {
        const language = macroParam(node, "language");
        const body = textOf(descendant(node, "ac:plain-text-body")).replace(/\n$/, "");
        out.push(block("codeBlock", { language }, [text(body)]));
        return;
      }
      if (MACRO_TONE[name]) {
        const title = macroParam(node, "title");
        const rich = descendant(node, "ac:rich-text-body");
        const kids: ImportedBlock[] = [];
        if (rich) for (const c of rich.children) blocksOf(c, kids, resolve);
        const callout = block(
          "callout",
          { tone: MACRO_TONE[name] },
          title ? [text(title)] : kids[0]?.type === "paragraph" ? (kids.shift()?.content as Inline[]) : []
        );
        callout.children = kids;
        out.push(callout);
        return;
      }
      if (name === "expand") {
        const title = macroParam(node, "title") || "Details";
        const rich = descendant(node, "ac:rich-text-body");
        const kids: ImportedBlock[] = [];
        if (rich) for (const c of rich.children) blocksOf(c, kids, resolve);
        const exp = block("expandable", { title }, [text(title)]);
        exp.children = kids;
        out.push(exp);
        return;
      }
      // toc, children, anchor, include, jira… navigation and integrations
      // that have no meaning outside Confluence. The rich body, if any, is
      // still content and still comes along.
      const rich = descendant(node, "ac:rich-text-body");
      if (rich) for (const c of rich.children) blocksOf(c, out, resolve);
      return;
    }
    case "hr":
      return; // rhythm, not content
    default: {
      // Structural wrappers (div, section, article, ac:layout…): recurse.
      // Anything with only text becomes a paragraph.
      const kids = elements(node);
      if (kids.length === 0) {
        const t = textOf(node).trim();
        if (t) out.push(block("paragraph", {}, [text(t.replace(/\s+/g, " "))]));
        return;
      }
      for (const c of node.children) blocksOf(c, out, resolve);
    }
  }
}

function findRows(table: XmlNode): XmlNode[] {
  const rows: XmlNode[] = [];
  const walk = (n: XmlNode) => {
    for (const c of elements(n)) {
      if (c.tag === "tr") rows.push(c);
      else if (c.tag === "thead" || c.tag === "tbody" || c.tag === "tfoot") walk(c);
    }
  };
  walk(table);
  return rows;
}

/** Convert a markup string to blocks. The entry point for everything. */
export function htmlToBlocks(
  markup: string,
  resolve?: AttachmentResolver
): ImportedBlock[] {
  const out: ImportedBlock[] = [];
  for (const node of parseXml(markup)) blocksOf(node, out, resolve);
  return out;
}

/**
 * For a fetched web page: find the part that is the article, not the site.
 * <article>, then <main>, then the whole <body>. Heuristic, and says so.
 */
export function pageContentToBlocks(
  html: string,
  resolve?: AttachmentResolver
): { title: string; blocks: ImportedBlock[] } {
  const forest = parseXml(html);
  const title = textOf(findFirst(forest, "title")).trim();
  const root =
    findFirst(forest, "article") ?? findFirst(forest, "main") ?? findFirst(forest, "body");
  const out: ImportedBlock[] = [];
  if (root) for (const c of root.children) blocksOf(c, out, resolve);
  else for (const node of forest) blocksOf(node, out, resolve);
  return { title, blocks: out };
}

function findFirst(nodes: (XmlNode | string)[], tag: string): XmlNode | undefined {
  for (const n of nodes) {
    if (typeof n === "string") continue;
    if (n.tag === tag) return n;
    const deep = findFirst(n.children, tag);
    if (deep) return deep;
  }
  return undefined;
}
