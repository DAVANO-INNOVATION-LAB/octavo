// Helpers for working with BlockNote document JSON on the server.
// The document is an array of blocks:
//   { id, type, props, content?: InlineContent[] | TableContent, children: Block[] }

export type InlineContent =
  | {
      type: "text";
      text: string;
      styles: Record<string, boolean | string>;
    }
  | { type: "link"; href: string; content: InlineContent[] };

export type TableContent = {
  type: "tableContent";
  rows: { cells: TableCell[] }[];
};

export type TableCell =
  | InlineContent[]
  | { type: "tableCell"; content: InlineContent[]; props?: Record<string, unknown> };

export type Block = {
  id: string;
  type: string;
  props: Record<string, string | number | boolean>;
  content?: InlineContent[] | TableContent;
  children: Block[];
};

export function parseBlocks(json: string): Block[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as Block[]) : [];
  } catch {
    return [];
  }
}

export function inlineText(content?: InlineContent[] | TableContent): string {
  if (!content) return "";
  if (!Array.isArray(content)) {
    return content.rows
      .map((r) => r.cells.map((c) => cellText(c)).join(" "))
      .join("\n");
  }
  return content
    .map((c) => (c.type === "text" ? c.text : inlineText(c.content)))
    .join("");
}

export function cellText(cell: TableCell): string {
  if (Array.isArray(cell)) return inlineText(cell);
  return inlineText(cell.content);
}

export function cellContent(cell: TableCell): InlineContent[] {
  if (Array.isArray(cell)) return cell;
  return cell.content ?? [];
}

/** Plain text of a whole document — used for the full-text index. */
export function extractText(json: string): string {
  const parts: string[] = [];
  const walk = (blocks: Block[]) => {
    for (const b of blocks) {
      const t = inlineText(b.content);
      if (t) parts.push(t);
      if (typeof b.props?.caption === "string" && b.props.caption)
        parts.push(b.props.caption);
      if (b.children?.length) walk(b.children);
    }
  };
  walk(parseBlocks(json));
  return parts.join("\n");
}

export type Heading = { id: string; level: number; text: string };

/** Top-level headings with stable anchor slugs — feeds the "On this page" rail. */
export function extractHeadings(blocks: Block[]): Heading[] {
  const seen = new Map<string, number>();
  const out: Heading[] = [];
  const walk = (list: Block[]) => {
    for (const b of list) {
      if (b.type === "heading") {
        const text = inlineText(b.content);
        if (text) {
          let slug = text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "section";
          const n = seen.get(slug) ?? 0;
          seen.set(slug, n + 1);
          if (n > 0) slug = `${slug}-${n + 1}`;
          out.push({
            id: slug,
            level: Number(b.props?.level ?? 2),
            text,
          });
        }
      }
      if (b.children?.length) walk(b.children);
    }
  };
  walk(blocks);
  return out;
}
