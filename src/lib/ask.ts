import "server-only";
import { getSetting, setSetting } from "./settings";
import { decryptSecret, encryptSecret } from "./crypto";
import { getPage, searchPages } from "./data";
import { parseBlocks } from "./blocks";
import { blocksToMarkdown } from "./markdown";

/**
 * Answering questions from the library, with citations.
 *
 * The model is the operator's own — anything speaking the OpenAI chat
 * completions shape, which covers Ollama, llama.cpp, vLLM, LM Studio, and the
 * hosted APIs. Nothing is built in and nothing is called unless an endpoint
 * has been configured, so a disconnected instance can run this against a
 * model on the same network and an unconfigured instance simply does not
 * offer it.
 *
 * Retrieval reuses the search index. That matters for more than economy: the
 * same permission rule applies, so a reader cannot obtain through an answer
 * what they could not obtain through a search.
 */

export type AskConfig = {
  endpoint: string;
  model: string;
  hasKey: boolean;
};

export type Passage = {
  pageId: string;
  title: string;
  space: string;
  slug: string;
  text: string;
};

export type Answer = {
  text: string;
  passages: Passage[];
  /** Indices of passages the answer actually cited. */
  cited: number[];
};

const ENDPOINT = "ask_endpoint";
const MODEL = "ask_model";
const KEY = "ask_key";

export function askConfig(): AskConfig | null {
  const endpoint = getSetting(ENDPOINT);
  if (!endpoint) return null;
  return {
    endpoint,
    model: getSetting(MODEL) ?? "",
    hasKey: Boolean(getSetting(KEY)),
  };
}

export function saveAskConfig(input: {
  endpoint: string;
  model: string;
  key?: string;
  clearKey?: boolean;
}) {
  const e = input.endpoint.trim();
  if (!e) {
    setSetting(ENDPOINT, null);
    setSetting(MODEL, null);
    setSetting(KEY, null);
    return;
  }
  try {
    const u = new URL(e);
    if (u.protocol !== "http:" && u.protocol !== "https:") return;
    setSetting(ENDPOINT, u.toString().replace(/\/+$/, ""));
  } catch {
    return;
  }
  setSetting(MODEL, input.model.trim().slice(0, 120) || null);
  // The key is stored encrypted with the instance secret. It is a credential
  // for someone else's service and has no business sitting in plain text in
  // a file operators back up and copy around.
  if (input.clearKey) setSetting(KEY, null);
  else if (input.key) setSetting(KEY, encryptSecret(input.key));
}

/** Trim a page to the part most likely to answer, keeping it readable. */
function excerpt(markdown: string, query: string, max = 1200): string {
  const clean = markdown.replace(/\n{3,}/g, "\n\n").trim();
  if (clean.length <= max) return clean;
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const lower = clean.toLowerCase();
  let best = 0;
  let bestScore = -1;
  // Slide a window and keep the one containing the most query terms.
  for (let i = 0; i < clean.length - max; i += 200) {
    const window = lower.slice(i, i + max);
    const score = terms.reduce((n, t) => n + (window.includes(t) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  const slice = clean.slice(best, best + max);
  return (best > 0 ? "…" : "") + slice + (best + max < clean.length ? "…" : "");
}

/**
 * Words that carry no signal in a question. Search requires every term to
 * match, so leaving these in means a question phrased politely finds less
 * than the same question typed as keywords.
 */
const STOPWORDS = new Set([
  "a","an","and","are","as","at","be","but","by","can","did","do","does","for",
  "from","get","had","has","have","how","i","if","in","is","it","its","me","my",
  "of","on","or","our","should","so","that","the","their","them","then","there",
  "these","this","to","was","we","what","when","where","which","who","why",
  "will","with","would","you","your",
]);

export function keyTerms(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Gather the passages an answer may be built from.
 *
 * Search demands that every term match, which is right for a search box and
 * wrong for a question. The content words are tried together first, then
 * individually, and the results are merged in the order search ranked them —
 * so a precise question still gets its precise answer, and a wordy one gets
 * something rather than nothing.
 */
export function retrieve(question: string, includePrivate: boolean, limit = 6): Passage[] {
  const terms = keyTerms(question);
  const seen = new Set<string>();
  const hits: ReturnType<typeof searchPages> = [];

  const add = (found: ReturnType<typeof searchPages>) => {
    for (const h of found) {
      if (seen.has(h.page_id)) continue;
      seen.add(h.page_id);
      hits.push(h);
    }
  };

  if (terms.length > 0) add(searchPages(terms.join(" "), includePrivate, limit));
  if (hits.length < limit) {
    for (const t of terms) {
      if (hits.length >= limit) break;
      add(searchPages(t, includePrivate, limit - hits.length));
    }
  }
  if (hits.length === 0) add(searchPages(question, includePrivate, limit));
  const out: Passage[] = [];
  for (const hit of hits.slice(0, limit)) {
    const page = getPage(hit.page_id);
    if (!page) continue;
    const md = blocksToMarkdown(parseBlocks(page.content));
    if (!md.trim()) continue;
    out.push({
      pageId: page.id,
      title: hit.title,
      space: hit.space_slug,
      slug: hit.page_slug,
      text: excerpt(md, question),
    });
  }
  return out;
}

/**
 * The prompt. Written so that a model with nothing useful in front of it says
 * so: a documentation assistant that invents an answer is worse than one that
 * declines, because the reader cannot tell the difference.
 */
export function buildPrompt(question: string, passages: Passage[]): string {
  const context = passages
    .map((p, i) => `[${i + 1}] ${p.title}\n${p.text}`)
    .join("\n\n---\n\n");
  return `You are answering a question using only the documentation passages below.

Rules:
- Use only what the passages say. Do not add knowledge from anywhere else.
- Cite the passages you used, inline, as [1], [2], and so on.
- If the passages do not answer the question, say exactly that and stop. Do not guess.
- Be brief and concrete. Prefer the words the documentation uses.

Passages:
${context}

Question: ${question}`;
}

/** Which passages an answer actually cited, as zero-based indices. */
export function citedIn(answer: string, count: number): number[] {
  const found = new Set<number>();
  for (const m of answer.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(m[1]) - 1;
    if (n >= 0 && n < count) found.add(n);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Ask the configured model. Errors are returned as text rather than thrown:
 * an unreachable model is an ordinary condition on a network that may be
 * deliberately isolated, and it should read as one.
 */
export async function ask(
  question: string,
  includePrivate: boolean
): Promise<Answer | { error: string }> {
  const cfg = askConfig();
  if (!cfg) return { error: "No model is configured for this instance." };

  const passages = retrieve(question, includePrivate);
  if (passages.length === 0) {
    return {
      text: "Nothing in the library matches that question closely enough to answer from.",
      passages: [],
      cited: [],
    };
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  const stored = getSetting(KEY);
  if (stored) {
    try {
      headers["Authorization"] = `Bearer ${decryptSecret(stored)}`;
    } catch {
      return { error: "The stored model credential could not be read." };
    }
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const res = await fetch(`${cfg.endpoint}/chat/completions`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: cfg.model || undefined,
        temperature: 0,
        messages: [{ role: "user", content: buildPrompt(question, passages) }],
      }),
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { error: `The model answered with ${res.status} ${res.statusText}.` };
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) return { error: "The model returned an empty answer." };
    return { text, passages, cited: citedIn(text, passages.length) };
  } catch (err) {
    const why = (err as Error).name === "AbortError" ? "timed out" : (err as Error).message;
    return { error: `The model could not be reached (${why}).` };
  }
}
