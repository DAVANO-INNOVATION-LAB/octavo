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
