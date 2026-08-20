// Import a local Markdown document into Octavo as a private space, one page
// per top-level "## " section — the same conversion the app's importer uses.
// Usage: node scripts/import-doc.mjs <file.md> "<Space name>" [description]
import Database from "better-sqlite3";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const [file, spaceName, description = ""] = process.argv.slice(2);
if (!file || !spaceName) {
  console.error('usage: node scripts/import-doc.mjs <file.md> "<Space name>" [description]');
  process.exit(1);
}

// Stage the pure libs so Node can resolve their extensionless imports.
const STAGE = path.join(process.cwd(), ".import-stage");
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
for (const f of ["markdown", "blocks", "util"]) {
  writeFileSync(
    path.join(STAGE, `${f}.ts`),
    readFileSync(`src/lib/${f}.ts`, "utf8")
      .replace(/from "\.\/([a-z-]+)"/g, 'from "./$1.ts"')
      .replace(/import "server-only";\n?/g, "")
  );
}
const md = await import(pathToFileURL(path.join(STAGE, "markdown.ts")));

const A = "0123456789abcdefghjkmnpqrstvwxyz";
const id = () => [...randomBytes(16)].map((b) => A[b % 32]).join("");
const slugify = (s) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 64) || "untitled";

const raw = readFileSync(file, "utf8");
// Split on level-2 headings; anything before the first one is the opening page.
const parts = [];
let current = { title: null, lines: [] };
for (const line of raw.split("\n")) {
  const h2 = line.match(/^##\s+(.*)$/);
  if (h2) {
    if (current.lines.join("\n").trim() || current.title) parts.push(current);
    current = { title: h2[1].trim(), lines: [] };
  } else {
    current.lines.push(line);
  }
}
parts.push(current);

const db = new Database(path.join(process.cwd(), "data", "octavo.db"));
const now = Date.now();

const existing = db.prepare("SELECT id FROM spaces WHERE slug = ?").get(slugify(spaceName));
if (existing) {
  const pages = db.prepare("SELECT id FROM pages WHERE space_id = ?").all(existing.id);
  const delFts = db.prepare("DELETE FROM pages_fts WHERE page_id = ?");
  for (const p of pages) delFts.run(p.id);
  db.prepare("DELETE FROM spaces WHERE id = ?").run(existing.id);
  console.log("replaced the existing space");
}

const spaceId = id();
const maxPos = db.prepare("SELECT COALESCE(MAX(position),0) p FROM spaces").get().p;
db.prepare(
  `INSERT INTO spaces (id, slug, name, description, emoji, kind, visibility, shelf, typeface, corners, accent, position, created_at, updated_at)
   VALUES (?, ?, ?, ?, '', 'articles', 'private', 'Internal', 'atelier', 'rounded', 'vermilion', ?, ?, ?)`
).run(spaceId, slugify(spaceName), spaceName, description, maxPos + 1, now, now);

const textOf = (blocks) => {
  const out = [];
  const inline = (c) => Array.isArray(c)
    ? c.map((x) => (x.type === "text" ? x.text : inline(x.content))).join("") : "";
  const walk = (bs) => bs.forEach((b) => {
    if (Array.isArray(b.content)) out.push(inline(b.content));
    else if (b.content?.rows) b.content.rows.forEach((r) => r.cells.forEach((c) => out.push(inline(c))));
    if (b.children?.length) walk(b.children);
  });
  walk(blocks);
  return out.join("\n");
};

let pos = 1;
const seen = new Set();
for (const part of parts) {
  const body = part.lines.join("\n").trim();
  if (!body && !part.title) continue;
  const title = part.title ?? spaceName;
  // Drop a leading H1 that just repeats the title.
  const blocks = md.markdownToBlocks(body.replace(/^#\s+.*\n/, ""));
  if (!blocks.length) continue;
  let slug = slugify(title);
  let n = 2;
  while (seen.has(slug)) slug = `${slugify(title)}-${n++}`;
  seen.add(slug);
  const content = JSON.stringify(blocks);
  const plain = textOf(blocks);
  const pid = id();
  db.prepare(
    `INSERT INTO pages (id, space_id, parent_id, slug, title, content, content_text, position, published, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(pid, spaceId, slug, title, content, plain, pos++, now, now);
  db.prepare("INSERT INTO pages_fts (page_id, title, body) VALUES (?, ?, ?)").run(pid, title, plain);
  console.log(`  ${String(pos - 1).padStart(2, "0")}  ${title}`);
}

rmSync(STAGE, { recursive: true, force: true });
console.log(`\nPrivate space "${spaceName}" ready at /${slugify(spaceName)} — ${pos - 1} pages`);
