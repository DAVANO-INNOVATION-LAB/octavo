import { createHash } from "node:crypto";
import { codeToHtml, bundledLanguages } from "shiki";
import { CopyButton } from "./CopyButton";

// Highlighting is deterministic, so cache rendered HTML across requests.
// Bounded LRU: evict the oldest entry once full.
const HIGHLIGHT_CACHE = new Map<string, string>();
const CACHE_MAX = 500;

async function highlight(code: string, lang: string): Promise<string> {
  const key = createHash("sha1").update(lang).update("\0").update(code).digest("base64");
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
}: {
  code: string;
  language: string;
}) {
  const lang = language in bundledLanguages ? language : "text";
  const html = await highlight(code, lang);

  return (
    <figure
      className="codeblock group overflow-hidden rounded-xl border border-black/20 shadow-card"
      style={{ background: "var(--code-bg)" }}
    >
      <figcaption className="flex h-9 items-center justify-between border-b border-white/8 px-4">
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-[#8a8375]">
          {language || "code"}
        </span>
        <CopyButton text={code} />
      </figcaption>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </figure>
  );
}
