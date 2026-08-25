/**
 * A small, lenient XML/XHTML parser. Dependency-free on purpose, like the
 * YAML subset in ./yaml — an importer should not cost the codebase a
 * dependency tree.
 *
 * Lenient means it accepts what real exports actually contain: CDATA,
 * comments, processing instructions, namespaced tags (ac:image), void HTML
 * elements that never close (<br>, <img>), attributes with single, double, or
 * no quotes, and close tags that skip levels — an unmatched close pops the
 * stack to its opener if one exists and is otherwise ignored, which is what
 * browsers do and what survives hand-written HTML.
 *
 * It does not validate. Malformed input produces a best-effort tree, never a
 * throw: an importer's job is to rescue content, not to grade markup.
 */

export type XmlNode = {
  tag: string;
  attrs: Record<string, string>;
  children: (XmlNode | string)[];
};

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  nbsp: " ", mdash: "—", ndash: "–", hellip: "…",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  copy: "©", reg: "®", trade: "™", middot: "·",
  laquo: "«", raquo: "»", times: "×", deg: "°",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X"))
      return safeCodePoint(parseInt(body.slice(2), 16), whole);
    if (body.startsWith("#"))
      return safeCodePoint(parseInt(body.slice(1), 10), whole);
    return NAMED_ENTITIES[body] ?? whole;
  });
}

function safeCodePoint(n: number, fallback: string): string {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(n);
  } catch {
    return fallback;
  }
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/>]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const m of src.matchAll(re)) {
    const name = m[1].toLowerCase();
    if (!name || name === "/") continue;
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** Parse markup into a forest. Never throws. */
export function parseXml(input: string): (XmlNode | string)[] {
  const root: XmlNode = { tag: "#root", attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;

  const pushText = (raw: string) => {
    if (!raw) return;
    const text = decodeEntities(raw);
    if (text) top().children.push(text);
  };

  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      pushText(input.slice(i));
      break;
    }
    pushText(input.slice(i, lt));

    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", lt)) {
      const end = input.indexOf("]]>", lt + 9);
      const body = end === -1 ? input.slice(lt + 9) : input.slice(lt + 9, end);
      if (body) top().children.push(body);
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<!", lt) || input.startsWith("<?", lt)) {
      const end = input.indexOf(">", lt);
      i = end === -1 ? input.length : end + 1;
      continue;
    }

    const gt = input.indexOf(">", lt);
    if (gt === -1) {
      pushText(input.slice(lt));
      break;
    }
    const inner = input.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (!inner) continue;

    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim().toLowerCase();
      // Pop to the matching opener if it is anywhere on the stack; a close
      // with no opener is noise and skipping it loses nothing.
      for (let d = stack.length - 1; d >= 1; d--) {
        if (stack[d].tag === name) {
          stack.length = d;
          break;
        }
      }
      continue;
    }

    const selfClosed = inner.endsWith("/");
    const body = selfClosed ? inner.slice(0, -1) : inner;
    const nameMatch = body.match(/^[^\s/>]+/);
    if (!nameMatch) continue;
    const tag = nameMatch[0].toLowerCase();
    const node: XmlNode = {
      tag,
      attrs: parseAttrs(body.slice(nameMatch[0].length)),
      children: [],
    };

    // Raw-text HTML elements: everything to the close tag is text.
    if (!selfClosed && (tag === "script" || tag === "style")) {
      const close = input.slice(i).search(new RegExp(`</${tag}\\s*>`, "i"));
      i = close === -1 ? input.length : i + close + tag.length + 3;
      continue; // scripts and styles carry no content worth importing
    }

    top().children.push(node);
    if (!selfClosed && !VOID.has(tag)) stack.push(node);
  }
  return root.children;
}

/** All element children, skipping text. */
export function elements(node: XmlNode): XmlNode[] {
  return node.children.filter((c): c is XmlNode => typeof c !== "string");
}

/** The concatenated text beneath a node. */
export function textOf(node: XmlNode | string | undefined): string {
  if (node === undefined) return "";
  if (typeof node === "string") return node;
  return node.children.map((c) => textOf(c)).join("");
}

/** Depth-first search for every element with this tag. */
export function findAll(nodes: (XmlNode | string)[], tag: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (list: (XmlNode | string)[]) => {
    for (const n of list) {
      if (typeof n === "string") continue;
      if (n.tag === tag) out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** First direct element child with this tag. */
export function child(node: XmlNode, tag: string): XmlNode | undefined {
  return elements(node).find((c) => c.tag === tag);
}
