/**
 * Reading a Notion "Markdown & CSV" export.
 *
 * Notion's zip is markdown, so the generic markdown importer already lands
 * most of it. What it lands badly is everything Notion adds on top: a 32-hex
 * id welded onto every filename, internal links pointing at those filenames,
 * and a block of database properties sitting between the title and the first
 * paragraph. Imported raw, a Notion space arrives with titles like
 * "Meeting notes 8f3c1d2e4b5a69708192a3b4c5d6e7f8" and every internal link
 * broken — which is worse than not supporting it, because it looks supported.
 *
 * Everything here is pure: given names and text, produce names and text.
 */

/** Notion appends a 32-character hex id to every exported file and folder. */
const NOTION_ID = /[ _-]([0-9a-f]{32})(?=$|\.)/i;

/** The same id, as it appears inside an exported link (already percent-encoded). */
const NOTION_ID_ANY = /([0-9a-f]{32})/i;

/**
 * Is this a Notion export? Enough files must carry the id for it to be
 * unambiguous — one stray hex-named file in someone's own markdown zip
 * should not reroute their import.
 */
export function looksLikeNotion(names: string[]): boolean {
  const relevant = names.filter((n) => /\.(md|csv)$/i.test(n));
  if (relevant.length === 0) return false;
  const tagged = relevant.filter((n) => NOTION_ID.test(stripExt(baseName(n))));
  return tagged.length >= Math.max(1, Math.ceil(relevant.length * 0.6));
}

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

/** The id Notion gave this file, if it has one. */
export function notionId(pathOrName: string): string {
  const m = stripExt(baseName(pathOrName)).match(NOTION_ID);
  return m ? m[1].toLowerCase() : "";
}

/** A human title: the name without Notion's id, decoded and tidied. */
export function notionTitle(pathOrName: string): string {
  let name = stripExt(baseName(pathOrName));
  try {
    name = decodeURIComponent(name);
  } catch {
    /* a stray % is not worth failing an import over */
  }
  return name.replace(NOTION_ID, "").trim() || "Untitled";
}

/**
 * Strip Notion's ids from every path segment, so the tree that lands is the
 * tree someone recognises. Extensions are kept; the shape is not touched.
 */
export function cleanNotionPath(path: string): string {
  return path
    .split("/")
    .map((seg) => {
      const ext = seg.match(/\.[^.]+$/)?.[0] ?? "";
      const stem = ext ? seg.slice(0, -ext.length) : seg;
      let out = stem;
      try {
        out = decodeURIComponent(stem);
      } catch {
        /* leave it */
      }
      return out.replace(NOTION_ID, "").trim() + ext;
    })
    .join("/");
}

export type NotionProperty = { name: string; value: string };

/**
 * Split a Notion page into its title, its database properties, and its body.
 *
 * A page exported from a database opens with an H1 and then a run of
 * "Property: value" lines. They are real content — status, owner, dates — but
 * left inline they read as a broken paragraph, so they are lifted out and the
 * caller decides how to present them.
 */
export function splitNotionPage(markdown: string): {
  title: string;
  properties: NotionProperty[];
  body: string;
} {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let title = "";
  while (i < lines.length && lines[i].trim() === "") i++;
  const h1 = lines[i]?.match(/^#\s+(.*)$/);
  if (h1) {
    title = h1[1].trim();
    i++;
  }
  while (i < lines.length && lines[i].trim() === "") i++;

  const properties: NotionProperty[] = [];
  // Properties run until the first blank line that is followed by real prose.
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") break;
    const m = line.match(/^([A-Za-z][\w \-/]{0,40}):\s*(.*)$/);
    if (!m) break;
    // A markdown heading or list is body, whatever punctuation it contains.
    if (/^\s*[#*\->]/.test(line)) break;
    properties.push({ name: m[1].trim(), value: m[2].trim() });
    i++;
  }
  if (properties.length === 0) {
    // Nothing was lifted, so nothing was consumed: hand back the original body.
    return { title, properties, body: lines.slice(h1 ? 1 : 0).join("\n").trim() };
  }
  return { title, properties, body: lines.slice(i).join("\n").trim() };
}

/**
 * Rewrite Notion's internal links to wherever those pages ended up.
 *
 * Notion links by exported filename — `[Roadmap](Roadmap%20a1b2....md)` — so
 * the id is the join key. A link whose target was not part of the export is
 * left exactly as written rather than pointed somewhere plausible: a link to
 * nothing is honest, a link to the wrong page is not.
 */
export function rewriteNotionLinks(
  markdown: string,
  hrefById: Map<string, string>
): string {
  return markdown.replace(
    /\]\(([^)\s]+)(\s+"[^"]*")?\)/g,
    (whole, target: string, titlePart: string | undefined) => {
      if (/^(https?:|mailto:|#|\/)/i.test(target)) return whole;
      let decoded = target;
      try {
        decoded = decodeURIComponent(target);
      } catch {
        /* leave it */
      }
      const id = decoded.match(NOTION_ID_ANY)?.[1]?.toLowerCase();
      if (!id) return whole;
      const href = hrefById.get(id);
      return href ? `](${href}${titlePart ?? ""})` : whole;
    }
  );
}

/**
 * A Notion database exported as CSV, as a table.
 *
 * Notion writes one CSV per database view beside the folder of its pages.
 * Turned into a table it is readable at a glance; left as a file attachment
 * it is a download nobody opens.
 */
export function notionCsvToRows(csv: string, maxRows = 200): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") {
      row.push(cur); cur = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
      if (rows.length >= maxRows) return rows;
    } else if (c !== "\r") cur += c;
  }
  row.push(cur);
  if (row.some((v) => v.trim() !== "")) rows.push(row);
  return rows;
}
