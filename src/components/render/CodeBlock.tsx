import { createHash } from "node:crypto";
import { codeToHtml, bundledLanguages } from "shiki";
import { CopyButton } from "./CopyButton";
import { CodeToggles } from "./CodeToggles";

// Highlighting is deterministic, so cache rendered HTML across requests.
// Bounded LRU: evict the oldest entry once full.
const HIGHLIGHT_CACHE = new Map<string, string>();
const CACHE_MAX = 500;

/** "3", "2-5", "1,4-6" — the lines a reader should look at first. */
function parseHighlights(spec: string): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const range = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) out.add(i);
      continue;
    }
    const one = Number(part.trim());
    if (Number.isInteger(one) && one > 0) out.add(one);
  }
  return out;
}

async function highlight(
  code: string,
  lang: string,
  highlights: Set<number>
): Promise<string> {
  const key = createHash("sha1")
    .update(lang)
    .update("\0")
    .update([...highlights].sort((a, b) => a - b).join(","))
    .update("\0")
    .update(code)
    .digest("base64");
  const hit = HIGHLIGHT_CACHE.get(key);
  if (hit !== undefined) {
    // refresh recency
    HIGHLIGHT_CACHE.delete(key);
    HIGHLIGHT_CACHE.set(key, hit);
    return hit;
  }
  const html = await codeToHtml(code, {
    lang,
    theme: "vitesse-dark",
    colorReplacements: { "#121212": "transparent" },
    transformers: [
      {
        line(node, line) {
          // Every line carries its number so CSS can render the gutter, and
          // marked lines get a band the eye lands on first.
          node.properties["data-line"] = String(line);
          if (highlights.has(line)) {
            const cls = String(node.properties.class ?? "");
            node.properties.class = `${cls} line-marked`.trim();
          }
        },
      },
    ],
  });
  if (HIGHLIGHT_CACHE.size >= CACHE_MAX) {
    const oldest = HIGHLIGHT_CACHE.keys().next().value;
    if (oldest) HIGHLIGHT_CACHE.delete(oldest);
  }
  HIGHLIGHT_CACHE.set(key, html);
  return html;
}

/**
 * Server-rendered code block: Shiki highlighting, always on a dark ground
 * (the "printer's slug" look), with a language label and copy button.
 */
export async function CodeBlock({
  code,
  language,
  meta,
}: {
  code: string;
  language: string;
  /** Block props: filename, highlighted lines, gutter and wrap preferences. */
  meta?: {
    filename?: string;
    highlight?: string;
    lineNumbers?: boolean;
    wrap?: boolean;
  };
}) {
  const lang = language in bundledLanguages ? language : "text";
  const highlights = parseHighlights(meta?.highlight ?? "");
  const html = await highlight(code, lang, highlights);
  const lineCount = code.split("\n").length;
  // Numbers earn their place once a block is long enough to point at a line.
  const numbers = meta?.lineNumbers ?? lineCount >= 6;

  return (
    <figure
      className={`codeblock group overflow-hidden rounded-xl border border-black/20 shadow-card${
        numbers ? " codeblock-numbered" : ""
      }${meta?.wrap ? " codeblock-wrap" : ""}`}
      style={{ background: "var(--code-bg)" }}
    >
      <figcaption className="flex h-9 items-center justify-between gap-3 border-b border-white/8 px-4">
        <span className="min-w-0 truncate font-mono text-[11px] text-[#8a8375]">
          {meta?.filename ? (
            <span className="text-[#c9c2b2]">{meta.filename}</span>
          ) : (
            <span className="uppercase tracking-[0.08em]">{language || "code"}</span>
          )}
          {meta?.filename && (
            <span className="ml-2 uppercase tracking-[0.08em]">{language}</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <CodeToggles />
          <CopyButton text={code} />
        </span>
      </figcaption>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </figure>
  );
}
