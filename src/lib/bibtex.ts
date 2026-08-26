/**
 * A BibTeX reader, dependency-free like the YAML and XML readers beside it.
 *
 * Parses the shape people actually have in .bib files: @article/@book/@misc
 * entries, braced or quoted values, nested braces (which is how BibTeX
 * protects capitalisation — {DNA} must stay DNA), LaTeX escapes for accented
 * characters, string concatenation with #, and @string macros. Comments and
 * @preamble are skipped.
 *
 * It does not validate. A malformed entry yields what could be read rather
 * than an exception, on the same principle as the importers: rescue the
 * citation, do not grade the file.
 */

export type Reference = {
  /** The citation key: \cite{key} and Octavo's [@key]. */
  key: string;
  /** article, book, inproceedings… lowercased. */
  type: string;
  fields: Record<string, string>;
};

/** LaTeX accent and symbol escapes common in bibliographies. */
const LATEX: [RegExp, string][] = [
  [/\\'\{?([aeiouAEIOUnNcCyY])\}?/g, "$1́"],
  [/\\`\{?([aeiouAEIOU])\}?/g, "$1̀"],
  [/\\"\{?([aeiouAEIOUyY])\}?/g, "$1̈"],
  [/\\\^\{?([aeiouAEIOU])\}?/g, "$1̂"],
  [/\\~\{?([anoANO])\}?/g, "$1̃"],
  [/\\c\{?([cC])\}?/g, "$1̧"],
  [/\\ss\b/g, "ß"],
  [/\\&/g, "&"],
  [/\\%/g, "%"],
  [/\\\$/g, "$"],
  [/\\_/g, "_"],
  [/\\#/g, "#"],
  [/--/g, "–"],
  [/``|''/g, '"'],
];

function clean(raw: string): string {
  let s = raw;
  for (const [re, to] of LATEX) s = s.replace(re, to);
  // Braces have done their job (grouping, capitalisation protection) by now.
  s = s.replace(/[{}]/g, "");
  return s.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Read a brace-balanced or quoted value starting at `i`. */
function readValue(
  src: string,
  i: number,
  macros: Record<string, string>
): { value: string; next: number } {
  const parts: string[] = [];
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] === "{") {
      let depth = 0;
      const start = ++i;
      depth = 1;
      while (i < src.length && depth > 0) {
        if (src[i] === "\\") i += 2;
        else if (src[i] === "{") { depth++; i++; }
        else if (src[i] === "}") { depth--; i++; }
        else i++;
      }
      parts.push(src.slice(start, i - 1));
    } else if (src[i] === '"') {
      const start = ++i;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") i += 2;
        else i++;
      }
      parts.push(src.slice(start, i));
      i++;
    } else {
      // A bare word: a number, or a @string macro name.
      const start = i;
      while (i < src.length && /[^\s,#}]/.test(src[i])) i++;
      const word = src.slice(start, i);
      parts.push(macros[word.toLowerCase()] ?? word);
    }
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] === "#") { i++; continue; } // concatenation
    break;
  }
  return { value: parts.join(""), next: i };
}

export function parseBibtex(src: string): Reference[] {
  const out: Reference[] = [];
  const macros: Record<string, string> = {};
  let i = 0;

  while (i < src.length) {
    const at = src.indexOf("@", i);
    if (at === -1) break;
    i = at + 1;
    const typeStart = i;
    while (i < src.length && /[a-zA-Z]/.test(src[i])) i++;
    const type = src.slice(typeStart, i).toLowerCase();
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== "{" && src[i] !== "(") continue;
    const closer = src[i] === "{" ? "}" : ")";
    i++;

    if (type === "comment" || type === "preamble") {
      // Skip to the matching close.
      let depth = 1;
      while (i < src.length && depth > 0) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
        i++;
      }
      continue;
    }

    if (type === "string") {
      while (i < src.length && /\s/.test(src[i])) i++;
      const nameStart = i;
      while (i < src.length && /[^\s=]/.test(src[i])) i++;
      const name = src.slice(nameStart, i).trim().toLowerCase();
      while (i < src.length && src[i] !== "=") i++;
      i++;
      const { value, next } = readValue(src, i, macros);
      macros[name] = value;
      i = next;
      while (i < src.length && src[i] !== closer) i++;
      i++;
      continue;
    }

    // key, then comma-separated field = value pairs
    while (i < src.length && /\s/.test(src[i])) i++;
    const keyStart = i;
    while (i < src.length && !/[,\s}]/.test(src[i])) i++;
    const key = src.slice(keyStart, i).trim();
    const fields: Record<string, string> = {};

    for (;;) {
      while (i < src.length && /[\s,]/.test(src[i])) i++;
      if (i >= src.length || src[i] === closer) { i++; break; }
      const nameStart = i;
      while (i < src.length && /[^\s=,}]/.test(src[i])) i++;
      const name = src.slice(nameStart, i).trim().toLowerCase();
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src[i] !== "=") {
        // Not a field after all — bail out of this entry rather than spin.
        if (src[i] === closer) { i++; }
        break;
      }
      i++;
      const { value, next } = readValue(src, i, macros);
      i = next;
      if (name) fields[name] = clean(value);
    }

    if (key) out.push({ key, type, fields });
  }
  return out;
}

/** "Author, A. and Berg, B." → ["Author, A.", "Berg, B."] */
export function splitAuthors(raw: string): string[] {
  return raw
    .split(/\s+and\s+/i)
    .map((a) => a.trim())
    .filter(Boolean);
}

/** "Lovelace, Ada" and "Ada Lovelace" both → "Lovelace, A." */
function surnameInitial(author: string): string {
  const a = author.trim();
  if (a.includes(",")) {
    const [last, rest] = a.split(",", 2);
    const initials = (rest ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((n) => `${n[0]}.`)
      .join(" ");
    return initials ? `${last.trim()}, ${initials}` : last.trim();
  }
  const parts = a.split(/\s+/);
  if (parts.length === 1) return a;
  const last = parts.pop()!;
  return `${last}, ${parts.map((n) => `${n[0]}.`).join(" ")}`;
}

/**
 * One rendered reference line, in a house style close to CSL "author-date".
 * Deliberately one readable style rather than a style engine: a documentation
 * tool should make a citation legible and linkable, not win an argument about
 * APA versus Chicago.
 */
export function formatReference(ref: Reference): string {
  const f = ref.fields;
  const authors = f.author ? splitAuthors(f.author).map(surnameInitial) : [];
  const who =
    authors.length === 0
      ? (f.editor ? splitAuthors(f.editor).map(surnameInitial).join(", ") : "")
      : authors.length > 3
        ? `${authors[0]} et al.`
        : authors.join(", ");
  const year = f.year ? ` (${f.year})` : "";
  const title = f.title ? ` ${f.title}.` : "";
  const venue = f.journal || f.booktitle || f.publisher || f.school || f.institution;
  const where = venue ? ` ${venue}` : "";
  const vol = f.volume ? ` ${f.volume}` : "";
  const pages = f.pages ? `, ${f.pages.replace(/--/g, "–")}` : "";
  const tail = venue ? `${where}${vol}${pages}.` : "";
  return `${who}${year}${title}${tail}`.replace(/\s+/g, " ").trim();
}

/** The link a reference should carry, if any. DOI wins over a bare URL. */
export function referenceHref(ref: Reference): string | null {
  const doi = ref.fields.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
  if (doi) return `https://doi.org/${doi}`;
  const url = ref.fields.url;
  if (url && /^https?:\/\//.test(url)) return url;
  return null;
}

/** In-text citations found in prose: [@key] and [@key1; @key2]. */
export function citedKeys(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[@([^\]]+)\]/g)) {
    for (const part of m[1].split(";")) {
      const key = part.trim().replace(/^@/, "");
      if (key) out.push(key);
    }
  }
  return out;
}
