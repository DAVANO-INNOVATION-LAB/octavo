// Seeds ~150 real technical documents as test data:
//  - 120 arXiv abstracts (4 CS categories × 30) — one space per category
//  - 30 classic IETF RFCs (freely redistributable) — one space
// Usage: node scripts/seed-corpus.mjs
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import path from "node:path";

const db = new Database(path.join(process.cwd(), "data", "octavo.db"));
db.pragma("journal_mode = WAL");

const A = "0123456789abcdefghjkmnpqrstvwxyz";
const id = () => [...randomBytes(16)].map((b) => A[b % 32]).join("");
const now = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T = (text, styles = {}) => ({ type: "text", text, styles });
const P = (...c) => ({ id: id(), type: "paragraph", props: {}, content: c, children: [] });
const H = (level, text) => ({ id: id(), type: "heading", props: { level }, content: [T(text)], children: [] });
const LI = (...c) => ({ id: id(), type: "bulletListItem", props: {}, content: c, children: [] });
const CODE = (lang, src) => ({ id: id(), type: "codeBlock", props: { language: lang }, content: [T(src)], children: [] });
const LINK = (text, href) => ({ type: "link", href, content: [T(text)] });

const slugify = (s) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "untitled";

const textOf = (blocks) => {
  const parts = [];
  const inline = (c) => (Array.isArray(c) ? c.map((x) => (x.type === "text" ? x.text : inline(x.content))).join("") : "");
  const walk = (bs) => bs.forEach((b) => { if (Array.isArray(b.content)) parts.push(inline(b.content)); if (b.children?.length) walk(b.children); });
  walk(blocks);
  return parts.join("\n");
};

function makeSpace(slug, name, description, kind, position) {
  const sid = id();
  db.prepare(
    `INSERT INTO spaces (id, slug, name, description, emoji, kind, visibility, accent, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', ?, 'public', 'vermilion', ?, ?, ?)`
  ).run(sid, slug, name, description, kind, position, now, now);
  return sid;
}

const usedSlugs = new Map(); // spaceId -> Set
function insertPage(spaceId, title, blocks, position) {
  const pid = id();
  const set = usedSlugs.get(spaceId) ?? new Set();
  usedSlugs.set(spaceId, set);
  let slug = slugify(title);
  let i = 2;
  while (set.has(slug)) slug = `${slugify(title)}-${i++}`;
  set.add(slug);
  const content = JSON.stringify(blocks);
  const body = textOf(blocks);
  db.prepare(
    `INSERT INTO pages (id, space_id, parent_id, slug, title, content, content_text, position, published, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(pid, spaceId, slug, title.slice(0, 200), content, body, position, now, now);
  db.prepare("INSERT INTO pages_fts (page_id, title, body) VALUES (?, ?, ?)").run(pid, title.slice(0, 200), body);
}

/* ---- arXiv ---- */

const CATEGORIES = [
  { cat: "cs.DC", slug: "arxiv-distributed-systems", name: "arXiv · Distributed Systems", desc: "Recent distributed, parallel, and cluster computing abstracts from arXiv (cs.DC)." },
  { cat: "cs.SE", slug: "arxiv-software-engineering", name: "arXiv · Software Engineering", desc: "Recent software engineering abstracts from arXiv (cs.SE)." },
  { cat: "cs.LG", slug: "arxiv-machine-learning", name: "arXiv · Machine Learning", desc: "Recent machine learning abstracts from arXiv (cs.LG)." },
  { cat: "cs.CR", slug: "arxiv-security", name: "arXiv · Security & Cryptography", desc: "Recent security and cryptography abstracts from arXiv (cs.CR)." },
];

const unescape = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

async function fetchArxiv(cat, max) {
  const url = `https://export.arxiv.org/api/query?search_query=cat:${cat}&sortBy=submittedDate&sortOrder=descending&max_results=${max}`;
  const res = await fetch(url, { headers: { "User-Agent": "octavo-test-seed/0.1" } });
  if (!res.ok) throw new Error(`arxiv ${cat}: HTTP ${res.status}`);
  const xml = await res.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  return entries.map((e) => ({
    title: unescape(e.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "Untitled"),
    summary: unescape(e.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? ""),
    link: e.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() ?? "",
    published: (e.match(/<published>([\s\S]*?)<\/published>/)?.[1] ?? "").slice(0, 10),
    authors: [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => unescape(m[1])).slice(0, 8),
  }));
}

/* ---- RFCs ---- */

const RFC_LIST = [
  768, 791, 792, 793, 826, 854, 959, 1034, 1035, 1157,
  1918, 1939, 2045, 2119, 2328, 2616, 2818, 3092, 3986, 4271,
  4632, 5321, 5389, 6455, 6749, 7231, 7540, 8446, 9110, 9293,
];

function rfcToBlocks(raw, rfcNum) {
  // Strip page breaks and running headers/footers.
  const cleaned = raw
    .replace(/\f/g, "\n")
    .split("\n")
    .filter((l) => !/^\s*(RFC \d+.*)?\[Page \d+\]\s*$/.test(l))
    .filter((l) => !/^\s*RFC \d+\s+.*\s+\S+ \d{4}\s*$/.test(l))
    .join("\n");
  const paras = cleaned.split(/\n\s*\n+/).map((p) => p.trimEnd()).filter((p) => p.trim());
  const blocks = [];
  let chars = 0;
  for (const p of paras) {
    if (chars > 24000) break;
    const lines = p.split("\n");
    const indented = lines.filter((l) => /^\s{6,}\S/.test(l)).length;
    if (lines.length > 1 && indented / lines.length > 0.5) {
      blocks.push(CODE("text", p));
    } else {
      const text = p.replace(/\n\s*/g, " ").trim();
      if (/^[A-Z0-9][A-Za-z0-9 .:\-]{0,60}$/.test(text) && text.length < 60 && !text.endsWith(".")) {
        blocks.push(H(2, text));
      } else {
        blocks.push(P(T(text)));
      }
    }
    chars += p.length;
  }
  blocks.push(P(T("Full text: "), LINK(`rfc-editor.org/rfc/rfc${rfcNum}`, `https://www.rfc-editor.org/rfc/rfc${rfcNum}`)));
  return blocks;
}

/* ---- main ---- */

const basePos = (db.prepare("SELECT COALESCE(MAX(position),0) p FROM spaces").get()).p;
let total = 0;

for (let c = 0; c < CATEGORIES.length; c++) {
  const { cat, slug, name, desc } = CATEGORIES[c];
  if (db.prepare("SELECT 1 FROM spaces WHERE slug=?").get(slug)) { console.log(`skip ${slug} (exists)`); continue; }
  const papers = await fetchArxiv(cat, 30);
  const sid = makeSpace(slug, name, desc, "articles", basePos + 1 + c);
  papers.forEach((p, i) => {
    const blocks = [
      P(T(p.summary)),
      H(2, "Details"),
      LI(T("Authors: ", { bold: true }), T(p.authors.join(", "))),
      LI(T("Published: ", { bold: true }), T(p.published)),
      LI(T("Source: ", { bold: true }), LINK(p.link.replace("http://", "https://"), p.link.replace("http://", "https://"))),
    ];
    insertPage(sid, p.title, blocks, i + 1);
    total++;
  });
  console.log(`${name}: ${papers.length} abstracts`);
  await sleep(3100); // arXiv rate-limit etiquette
}

if (!db.prepare("SELECT 1 FROM spaces WHERE slug='rfc-reading-room'").get()) {
  const sid = makeSpace(
    "rfc-reading-room",
    "RFC Reading Room",
    "Thirty foundational IETF RFCs — the documents the internet runs on.",
    "docs",
    basePos + 5
  );
  let pos = 1;
  for (const n of RFC_LIST) {
    try {
      const res = await fetch(`https://www.rfc-editor.org/rfc/rfc${n}.txt`, { headers: { "User-Agent": "octavo-test-seed/0.1" } });
      if (!res.ok) { console.log(`rfc${n}: HTTP ${res.status} — skipped`); continue; }
      const raw = await res.text();
      const titleLine = raw.split("\n").map((l) => l.trim()).filter(Boolean).find((l) => /^[A-Z].{8,80}$/.test(l) && !/^(Network Working Group|Request for Comments|Internet Engineering|Obsoletes|Updates|Category|ISSN|STD)/i.test(l));
      const title = `RFC ${n}: ${titleLine ?? "Untitled"}`;
      insertPage(sid, title, rfcToBlocks(raw, n), pos++);
      total++;
      await sleep(250);
    } catch (e) {
      console.log(`rfc${n}: ${e.message} — skipped`);
    }
  }
  console.log(`RFC Reading Room: ${pos - 1} documents`);
}

console.log(`Corpus seeded: ${total} documents`);
