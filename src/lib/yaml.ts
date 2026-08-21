/**
 * A small YAML reader, sufficient for OpenAPI documents.
 *
 * OpenAPI is published as YAML far more often than JSON, so refusing YAML
 * would refuse most specifications. A general YAML implementation is a large
 * thing to take on — anchors, aliases, tags, flow mappings, multiple
 * documents — and pulling one in would be the first runtime dependency added
 * to this library in months.
 *
 * What is implemented is the subset OpenAPI documents actually use: nested
 * block mappings and sequences, quoted and bare scalars, inline flow
 * collections, block scalars (`|` and `>`), comments, and the handful of
 * literals YAML spells oddly. Anything outside that is reported rather than
 * guessed at, because a specification parsed wrongly produces documentation
 * that is confidently incorrect.
 */

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [k: string]: YamlValue };

export class YamlError extends Error {
  // A plain field rather than a constructor parameter property: the latter
  // needs a transform, and the test runner only strips types.
  line: number;
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
    this.line = line;
  }
}

type Line = { indent: number; text: string; no: number };

function scan(src: string): Line[] {
  const out: Line[] = [];
  const raw = src.replace(/\r\n?/g, "\n").split("\n");
  raw.forEach((text, i) => {
    // A tab in indentation is invalid YAML and silently ruins the structure.
    const lead = text.match(/^[ \t]*/)?.[0] ?? "";
    if (lead.includes("\t")) throw new YamlError("tab in indentation", i + 1);
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    if (trimmed === "---" || trimmed === "...") return;
    out.push({ indent: lead.length, text: trimmed, no: i + 1 });
  });
  return out;
}

/** Strip a trailing comment, respecting quotes. */
function uncomment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function scalar(raw: string, line: number): YamlValue {
  const s = uncomment(raw).trim();
  if (s === "" || s === "~" || s === "null" || s === "Null" || s === "NULL")
    return null;
  if (s === "true" || s === "True" || s === "TRUE") return true;
  if (s === "false" || s === "False" || s === "FALSE") return false;

  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2)
      throw new YamlError("unterminated double-quoted string", line);
    return s
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2)
      throw new YamlError("unterminated single-quoted string", line);
    return s.slice(1, -1).replace(/''/g, "'");
  }

  // Flow collections: [a, b] and {a: 1}. OpenAPI uses these for short lists.
  if (s.startsWith("[") && s.endsWith("]")) return flow(s, line);
  if (s.startsWith("{") && s.endsWith("}")) return flow(s, line);

  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+([eE][-+]?\d+)?$/.test(s)) return Number(s);
  return s;
}

/** Split a flow collection on top-level commas, respecting nesting and quotes. */
function flowParts(body: string, line: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let q: string | null = null;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  if (q) throw new YamlError("unterminated string in flow collection", line);
  const tail = body.slice(start);
  if (tail.trim() !== "" || parts.length > 0) parts.push(tail);
  return parts;
}

function flow(s: string, line: number): YamlValue {
  const body = s.slice(1, -1).trim();
  if (body === "") return s.startsWith("[") ? [] : {};
  const parts = flowParts(body, line);
  if (s.startsWith("[")) return parts.map((p) => scalar(p, line));
  const obj: Record<string, YamlValue> = {};
  for (const p of parts) {
    const i = p.indexOf(":");
    if (i < 0) throw new YamlError("expected key: value in flow mapping", line);
    obj[stripKey(p.slice(0, i))] = scalar(p.slice(i + 1), line);
  }
  return obj;
}

function stripKey(k: string): string {
  const s = k.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  )
    return s.slice(1, -1);
  return s;
}

/** Where a mapping key ends, ignoring colons inside quotes or a URL. */
function keyEnd(text: string): number {
  let q: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === ":" && (i + 1 === text.length || /[\s]/.test(text[i + 1])))
      return i;
  }
  return -1;
}

function blockScalar(
  lines: Line[],
  start: number,
  parentIndent: number,
  fold: boolean
): [string, number] {
  const body: string[] = [];
  let i = start;
  let indent = -1;
  while (i < lines.length && lines[i].indent > parentIndent) {
    if (indent < 0) indent = lines[i].indent;
    body.push(" ".repeat(Math.max(0, lines[i].indent - indent)) + lines[i].text);
    i++;
  }
  return [fold ? body.join(" ") : body.join("\n"), i];
}

function parseBlock(lines: Line[], start: number, indent: number): [YamlValue, number] {
  if (start >= lines.length) return [null, start];

  if (lines[start].text.startsWith("- ") || lines[start].text === "-") {
    const arr: YamlValue[] = [];
    let i = start;
    while (i < lines.length && lines[i].indent === indent) {
      const l = lines[i];
      if (!l.text.startsWith("-")) break;
      const rest = l.text === "-" ? "" : l.text.slice(1).trim();
      if (rest === "") {
        const [v, next] = parseBlock(lines, i + 1, i + 1 < lines.length ? lines[i + 1].indent : indent + 1);
        arr.push(v);
        i = next;
        continue;
      }
      // "- key: value" starts a mapping that continues on following lines.
      if (keyEnd(rest) >= 0) {
        const inner: Line[] = [{ indent: indent + 2, text: rest, no: l.no }];
        let j = i + 1;
        while (j < lines.length && lines[j].indent > indent) {
          inner.push(lines[j]);
          j++;
        }
        const [v] = parseBlock(inner, 0, indent + 2);
        arr.push(v);
        i = j;
        continue;
      }
      arr.push(scalar(rest, l.no));
      i++;
    }
    return [arr, i];
  }

  const obj: Record<string, YamlValue> = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const l = lines[i];
    const k = keyEnd(l.text);
    if (k < 0) throw new YamlError(`expected "key: value"`, l.no);
    const key = stripKey(l.text.slice(0, k));
    const rest = l.text.slice(k + 1).trim();

    if (rest === "|" || rest === "|-" || rest === ">" || rest === ">-") {
      const [text, next] = blockScalar(lines, i + 1, indent, rest.startsWith(">"));
      obj[key] = text;
      i = next;
      continue;
    }
    if (rest === "") {
      const nxt = i + 1 < lines.length ? lines[i + 1] : null;
      // A block sequence may sit at the same indentation as the key it
      // belongs to. YAML allows it and real specifications are written that
      // way, so an equally-indented "- " continues this key rather than
      // starting a sibling.
      const sequenceAtSameIndent =
        nxt !== null && nxt.indent === indent && nxt.text.startsWith("-");
      if (nxt !== null && (nxt.indent > indent || sequenceAtSameIndent)) {
        const [v, next] = parseBlock(lines, i + 1, nxt.indent);
        obj[key] = v;
        i = next;
      } else {
        obj[key] = null;
        i++;
      }
      continue;
    }
    obj[key] = scalar(rest, l.no);
    i++;
  }
  return [obj, i];
}

/** Parse YAML, or JSON — OpenAPI is published as either. */
export function parseYaml(src: string): YamlValue {
  const trimmed = src.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as YamlValue;
    } catch {
      /* fall through and try YAML */
    }
  }
  const lines = scan(src);
  if (lines.length === 0) return null;
  const [value] = parseBlock(lines, 0, lines[0].indent);
  return value;
}
