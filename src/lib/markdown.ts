// Markdown round-trip for BlockNote documents.
// Export favors portability (plain CommonMark-ish output); import parses the
// common constructs back into blocks. The lossless path is the JSON manifest
// in space exports — markdown is the "works everywhere else" path.

import {
  type Block,
  type InlineContent,
  type TableContent,
  cellContent,
} from "./blocks";
import { newId } from "./util";

/* ————— blocks → markdown ————— */

function inlineToMd(content?: InlineContent[] | TableContent): string {
  if (!content || !Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (c.type === "link") {
        return `[${inlineToMd(c.content)}](${c.href})`;
      }
      let text = c.text;
      const s = c.styles ?? {};
      if (s.code) return `\`${text}\``;
      if (s.bold) text = `**${text}**`;
      if (s.italic) text = `*${text}*`;
      if (s.strike) text = `~~${text}~~`;
      return text;
    })
    .join("");
}

function tableToMd(content: TableContent): string {
  const rows = content.rows ?? [];
  if (!rows.length) return "";
  const cells = (r: { cells: Parameters<typeof cellContent>[0][] }) =>
    r.cells.map((c) => inlineToMd(cellContent(c)).replace(/\|/g, "\\|"));
  const [head, ...rest] = rows;
  const h = cells(head);
  const lines = [
    `| ${h.join(" | ")} |`,
    `| ${h.map(() => "---").join(" | ")} |`,
    ...rest.map((r) => `| ${cells(r).join(" | ")} |`),
  ];
  return lines.join("\n");
}

const LIST_TYPES = new Set([
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
]);

export function blocksToMarkdown(blocks: Block[], depth = 0): string {
  const items: { text: string; list: boolean }[] = [];
  const out: string[] = [];
  const indent = "  ".repeat(depth);
  let numbered = 0;
  const take = (b: Block, kids: string) => {
    const text = out.splice(0).join("\n");
    const list = LIST_TYPES.has(b.type);
    items.push({ text: kids ? `${text}\n${kids}` : text, list });
  };

  for (const b of blocks) {
    if (b.type !== "numberedListItem") numbered = 0;
    const kids = b.children?.length
      ? blocksToMarkdown(b.children, depth + 1)
      : "";

    switch (b.type) {
      case "heading": {
        const level = Math.min(6, Math.max(1, Number(b.props?.level ?? 2)));
        out.push(`${"#".repeat(level)} ${inlineToMd(b.content)}`);
        break;
      }
      case "quote":
        out.push(`> ${inlineToMd(b.content)}`);
        break;
      case "bulletListItem":
        out.push(`${indent}- ${inlineToMd(b.content)}`);
        break;
      case "numberedListItem":
        out.push(`${indent}${++numbered}. ${inlineToMd(b.content)}`);
        break;
      case "checkListItem":
        out.push(
          `${indent}- [${b.props?.checked ? "x" : " "}] ${inlineToMd(b.content)}`
        );
        break;
      case "codeBlock": {
        const lang = String(b.props?.language ?? "");
        const code = Array.isArray(b.content)
          ? b.content.map((c) => (c.type === "text" ? c.text : "")).join("")
          : "";
        out.push(`\`\`\`${lang}\n${code}\n\`\`\``);
        break;
      }
      case "table":
        if (b.content && !Array.isArray(b.content))
          out.push(tableToMd(b.content));
        break;
      case "image": {
        const url = String(b.props?.url ?? "");
        const caption = String(b.props?.caption ?? "");
        if (url) out.push(`![${caption}](${url})`);
        break;
      }
      case "video":
      case "audio":
      case "file": {
        const url = String(b.props?.url ?? "");
        const name = String(b.props?.name ?? b.type);
        if (url) out.push(`[${name}](${url})`);
        break;
      }
      default: {
        const text = inlineToMd(b.content);
        if (text.trim()) out.push(text);
      }
    }
    take(b, kids);
  }

  const parts: string[] = [];
  let prevList = false;
  for (const it of items) {
    if (!it.text) continue;
    if (parts.length)
      parts.push(it.list && prevList ? "\n" : "\n\n");
    parts.push(it.text);
    prevList = it.list;
  }
  return parts.join("");
}

/* ————— markdown → blocks ————— */

type Inline = { type: "text"; text: string; styles: Record<string, boolean> };
type InlineNode = Inline | { type: "link"; href: string; content: Inline[] };

function text(t: string, styles: Record<string, boolean> = {}): Inline {
  return { type: "text", text: t, styles };
}

/** Parse inline markdown: `code`, **bold**, *italic*, ~~strike~~, [links](url). */
export function parseInline(
  src: string,
  styles: Record<string, boolean> = {}
): InlineNode[] {
  const out: InlineNode[] = [];
  let i = 0;
  let plain = "";
  const flush = () => {
    if (plain) out.push(text(plain, { ...styles }));
    plain = "";
  };

  while (i < src.length) {
    const rest = src.slice(i);
    let m: RegExpMatchArray | null;

    if ((m = rest.match(/^`([^`]+)`/))) {
      flush();
      out.push(text(m[1], { ...styles, code: true }));
      i += m[0].length;
    } else if ((m = rest.match(/^\*\*([^*]+)\*\*/))) {
      flush();
      out.push(...(parseInline(m[1], { ...styles, bold: true }) as InlineNode[]));
      i += m[0].length;
    } else if ((m = rest.match(/^~~([^~]+)~~/))) {
      flush();
      out.push(...(parseInline(m[1], { ...styles, strike: true }) as InlineNode[]));
      i += m[0].length;
    } else if ((m = rest.match(/^[*_]([^*_]+)[*_]/))) {
      flush();
      out.push(...(parseInline(m[1], { ...styles, italic: true }) as InlineNode[]));
      i += m[0].length;
    } else if ((m = rest.match(/^\[([^\]]*)\]\(([^)\s]+)\)/))) {
      flush();
      out.push({
        type: "link",
        href: m[2],
        content: parseInline(m[1], styles).filter(
          (n): n is Inline => n.type === "text"
        ),
      });
      i += m[0].length;
    } else {
      plain += src[i++];
    }
  }
  flush();
  return out;
}

type MdBlock = {
  id: string;
  type: string;
  props: Record<string, string | number | boolean>;
  content?: InlineNode[] | { type: "tableContent"; rows: { cells: Inline[][][] | InlineNode[][] }[] };
  children: MdBlock[];
};

function block(
  type: string,
  props: Record<string, string | number | boolean>,
  content?: MdBlock["content"]
): MdBlock {
  return { id: newId(), type, props, content, children: [] };
}

export function markdownToBlocks(md: string): MdBlock[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: MdBlock[] = [];
  let i = 0;
  let para: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    const joined = para.join(" ").trim();
    para = [];
    if (joined) out.push(block("paragraph", {}, parseInline(joined)));
  };

  // Nested list handling: stack of (indent, container)
  const listStack: { indent: number; node: MdBlock }[] = [];
  const pushListItem = (indent: number, node: MdBlock) => {
    while (listStack.length && listStack[listStack.length - 1].indent >= indent && listStack[listStack.length - 1].indent !== indent) {
      listStack.pop();
    }
    const parent =
      listStack.length && listStack[listStack.length - 1].indent < indent
        ? listStack[listStack.length - 1].node
        : null;
    if (parent) parent.children.push(node);
    else out.push(node);
    // this item may become a parent of deeper items
    while (listStack.length && listStack[listStack.length - 1].indent >= indent) listStack.pop();
    listStack.push({ indent, node });
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // fenced code
    const fence = trimmed.match(/^```(\S*)\s*$/);
    if (fence) {
      flushPara();
      listStack.length = 0;
      const lang = fence[1] ?? "";
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++; // closing fence
      out.push(
        block("codeBlock", { language: lang }, [text(buf.join("\n"))])
      );
      continue;
    }

    if (!trimmed) {
      flushPara();
      listStack.length = 0;
      i++;
      continue;
    }

    // heading
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      listStack.length = 0;
      out.push(
        block(
          "heading",
          { level: Math.min(3, h[1].length) },
          parseInline(h[2])
        )
      );
      i++;
      continue;
    }

    // horizontal rule — no divider block; skip
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushPara();
      i++;
      continue;
    }

    // blockquote
    if (trimmed.startsWith(">")) {
      flushPara();
      listStack.length = 0;
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        buf.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      out.push(block("quote", {}, parseInline(buf.join(" "))));
      continue;
    }

    // table
    if (
      trimmed.startsWith("|") &&
      i + 1 < lines.length &&
      /^\|[\s\-:|]+\|$/.test(lines[i + 1].trim())
    ) {
      flushPara();
      listStack.length = 0;
      const rows: { cells: InlineNode[][] }[] = [];
      const parseRow = (l: string) =>
        l
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => parseInline(c.trim().replace(/\\\|/g, "|")));
      rows.push({ cells: parseRow(lines[i]) });
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push({ cells: parseRow(lines[i]) });
        i++;
      }
      out.push(
        block("table", {}, {
          type: "tableContent",
          rows,
        } as MdBlock["content"])
      );
      continue;
    }

    // image on its own line
    const img = trimmed.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
    if (img) {
      flushPara();
      out.push(block("image", { url: img[2], caption: img[1] ?? "" }));
      i++;
      continue;
    }

    // list items (with indentation → nesting)
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flushPara();
      const indent = Math.floor(li[1].replace(/\t/g, "  ").length / 2);
      const rest = li[3];
      const check = rest.match(/^\[( |x|X)\]\s+(.*)$/);
      let node: MdBlock;
      if (check) {
        node = block(
          "checkListItem",
          { checked: check[1].toLowerCase() === "x" },
          parseInline(check[2])
        );
      } else if (/^\d/.test(li[2])) {
        node = block("numberedListItem", {}, parseInline(rest));
      } else {
        node = block("bulletListItem", {}, parseInline(rest));
      }
      pushListItem(indent, node);
      i++;
      continue;
    }

    // plain paragraph line
    listStack.length = 0;
    para.push(trimmed);
    i++;
  }
  flushPara();
  return out;
}

/** Strip a YAML-ish frontmatter block; return [meta, body]. */
export function splitFrontmatter(md: string): [Record<string, string>, string] {
  const meta: Record<string, string> = {};
  if (!md.startsWith("---\n")) return [meta, md];
  const end = md.indexOf("\n---", 4);
  if (end === -1) return [meta, md];
  const head = md.slice(4, end);
  for (const line of head.split("\n")) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  let body = md.slice(end + 4);
  body = body.replace(/^\n+/, "");
  return [meta, body];
}
