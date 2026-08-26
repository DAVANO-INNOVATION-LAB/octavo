import type { Block } from "./blocks";

/**
 * The composition pass a page goes through between storage and the reader.
 *
 * Three transformations, all server-side, all before any rendering:
 *
 *   variables      {{name}} in any text becomes the space's value for it
 *   audience       an ifvar block renders its content only when the named
 *                  variable matches; otherwise it vanishes entirely
 *   synced pages   a syncedPage block is replaced by the source page's
 *                  current blocks, fetched through a resolver the caller
 *                  supplies — which is where permissions live
 *
 * Pure by construction: the resolver is injected, so every rule here is
 * testable without a database. Embeds resolve one level deep only — an
 * embedded page's own embeds render as links, which makes cycles impossible
 * rather than merely detected.
 */

export type SpaceVars = Record<string, string>;

export type SyncedResolution =
  | { state: "ok"; title: string; href: string; blocks: Block[] }
  | { state: "forbidden" }
  | { state: "missing" };

export type PageResolver = (pageId: string) => SyncedResolution;

const VAR_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export function substituteVars(text: string, vars: SpaceVars): string {
  if (!text.includes("{{")) return text;
  return text.replace(VAR_PATTERN, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole
  );
}

function substituteInline(content: unknown, vars: SpaceVars): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((c) => {
    if (!c || typeof c !== "object") return c;
    const node = c as { text?: string; content?: unknown };
    const out = { ...node };
    if (typeof node.text === "string") out.text = substituteVars(node.text, vars);
    if (node.content) out.content = substituteInline(node.content, vars);
    return out;
  });
}

/** Parse the stored vars setting; tolerant of absence and damage. */
export function parseVars(raw: string | null): SpaceVars {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: SpaceVars = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && k.length <= 60) out[k] = v.slice(0, 500);
    }
    return out;
  } catch {
    return {};
  }
}

export function composeBlocks(
  blocks: Block[],
  vars: SpaceVars,
  resolvePage?: PageResolver
): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.type === "ifvar") {
      const name = String(b.props?.name ?? "");
      const equals = String(b.props?.equals ?? "");
      // Unset variable + empty condition means "matches" — a block written
      // before the space defined its variables should not silently vanish.
      const actual = vars[name] ?? "";
      if (actual !== equals) continue;
      // The condition holds: the block dissolves into its content.
      const inline = Array.isArray(b.content) ? b.content : [];
      if (inline.length > 0) {
        out.push({
          id: b.id,
          type: "paragraph",
          props: {},
          content: substituteInline(inline, vars) as Block["content"],
          children: [],
        });
      }
      out.push(...composeBlocks(b.children ?? [], vars, resolvePage));
      continue;
    }

    if (b.type === "syncedPage") {
      const pageId = String(b.props?.pageId ?? "");
      if (!pageId) continue;
      if (!resolvePage) {
        // Inside an embed already: nested embeds flatten to a mention, which
        // is what makes an embed cycle structurally impossible.
        out.push(note(b.id, `Embeds "${String(b.props?.title ?? "another page")}".`));
        continue;
      }
      const target = resolvePage(pageId);
      if (target.state === "missing") {
        out.push(note(b.id, "The embedded page no longer exists."));
        continue;
      }
      if (target.state === "forbidden") {
        // Say nothing about what it was. An embed must not leak the title
        // of a page the reader may not open.
        out.push(note(b.id, "An embedded page you don't have access to."));
        continue;
      }
      // One level only: strip nested embeds down to links by dropping their
      // resolver. Variables resolve with the HOST space's values — the
      // reader is reading this page, not that one.
      const inner = composeBlocks(target.blocks, vars, undefined).map((k) => ({
        ...k,
        id: `${b.id}-${k.id}`,
      }));
      out.push({
        id: b.id,
        type: "syncedFrame",
        props: { title: target.title, href: target.href },
        content: [],
        children: inner,
      });
      continue;
    }

    const next: Block = {
      ...b,
      content: substituteInline(b.content, vars) as Block["content"],
      children: composeBlocks(b.children ?? [], vars, resolvePage),
    };
    out.push(next);
  }
  return out;
}

function note(id: string, textContent: string): Block {
  return {
    id,
    type: "syncedNote",
    props: {},
    content: [{ type: "text", text: textContent, styles: {} }] as Block["content"],
    children: [],
  };
}

/** Every [@key] cited anywhere in a document, in order of first appearance. */
export function citationsIn(blocks: Block[]): string[] {
  const seen: string[] = [];
  const add = (text: string) => {
    for (const m of text.matchAll(/\[@([^\]]+)\]/g)) {
      for (const part of m[1].split(";")) {
        const key = part.trim().replace(/^@/, "");
        if (key && !seen.includes(key)) seen.push(key);
      }
    }
  };
  const walk = (list: Block[]) => {
    for (const b of list) {
      if (Array.isArray(b.content)) {
        for (const c of b.content as { text?: string }[]) {
          if (typeof c?.text === "string") add(c.text);
        }
      }
      if (b.children?.length) walk(b.children);
    }
  };
  walk(blocks);
  return seen;
}

/**
 * Turn [@key] in prose into a numbered link to the References entry.
 *
 * Runs after composition so it sees the final text — including anything a
 * variable substituted in. A key the bibliography does not have still gets a
 * number and a link: the References list says it is missing, and a silent
 * gap in the numbering would be harder to notice than an obvious one.
 */
export function linkCitations(blocks: Block[], order: string[]): Block[] {
  if (order.length === 0) return blocks;
  const numberOf = new Map(order.map((k, i) => [k, i + 1]));

  const rewriteInline = (content: unknown): unknown => {
    if (!Array.isArray(content)) return content;
    const out: unknown[] = [];
    for (const node of content) {
      const n = node as { type?: string; text?: string; styles?: unknown; content?: unknown };
      if (n?.type === "link" && n.content) {
        out.push({ ...n, content: rewriteInline(n.content) });
        continue;
      }
      if (typeof n?.text !== "string" || !n.text.includes("[@")) {
        out.push(node);
        continue;
      }
      let last = 0;
      const text = n.text;
      for (const m of text.matchAll(/\[@([^\]]+)\]/g)) {
        const at = m.index ?? 0;
        if (at > last) out.push({ ...n, text: text.slice(last, at) });
        const keys = m[1].split(";").map((k) => k.trim().replace(/^@/, "")).filter(Boolean);
        out.push({ type: "text", text: "[", styles: n.styles ?? {} });
        keys.forEach((key, i) => {
          if (i > 0) out.push({ type: "text", text: ", ", styles: n.styles ?? {} });
          out.push({
            type: "link",
            href: `#ref-${key}`,
            content: [{ type: "text", text: String(numberOf.get(key) ?? "?"), styles: {} }],
          });
        });
        out.push({ type: "text", text: "]", styles: n.styles ?? {} });
        last = at + m[0].length;
      }
      if (last < text.length) out.push({ ...n, text: text.slice(last) });
    }
    return out;
  };

  const walk = (list: Block[]): Block[] =>
    list.map((b) => ({
      ...b,
      content: rewriteInline(b.content) as Block["content"],
      children: b.children?.length ? walk(b.children) : (b.children ?? []),
    }));
  return walk(blocks);
}
