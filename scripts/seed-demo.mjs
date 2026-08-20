// Seeds the "Octavo Field Guide" demo space — shows off every block type.
// Usage: node scripts/seed-demo.mjs
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import path from "node:path";

const db = new Database(path.join(process.cwd(), "data", "octavo.db"));
db.pragma("journal_mode = WAL");

const A = "0123456789abcdefghjkmnpqrstvwxyz";
const id = () => [...randomBytes(16)].map((b) => A[b % 32]).join("");
const t = Date.now();

const T = (text, styles = {}) => ({ type: "text", text, styles });
const P = (...content) => ({ id: id(), type: "paragraph", props: {}, content, children: [] });
const H = (level, text) => ({ id: id(), type: "heading", props: { level }, content: [T(text)], children: [] });
const LI = (...content) => ({ id: id(), type: "bulletListItem", props: {}, content, children: [] });
const NLI = (...content) => ({ id: id(), type: "numberedListItem", props: {}, content, children: [] });
const CHK = (checked, text) => ({ id: id(), type: "checkListItem", props: { checked }, content: [T(text)], children: [] });
const Q = (text) => ({ id: id(), type: "quote", props: {}, content: [T(text)], children: [] });
const CODE = (language, code) => ({ id: id(), type: "codeBlock", props: { language }, content: [T(code)], children: [] });
const LINK = (text, href) => ({ type: "link", href, content: [T(text)] });

const text = (blocks) => {
  const parts = [];
  const walk = (bs) => bs.forEach((b) => {
    const inline = (c) => Array.isArray(c) ? c.map((x) => x.type === "text" ? x.text : inline(x.content)).join("") : "";
    if (Array.isArray(b.content)) parts.push(inline(b.content));
    else if (b.content?.rows) b.content.rows.forEach((r) => r.cells.forEach((c) => parts.push(inline(Array.isArray(c) ? c : c.content))));
    if (b.children?.length) walk(b.children);
  });
  walk(blocks);
  return parts.join("\n");
};

// ---- space ----
const spaceId = id();
db.prepare(
  `INSERT INTO spaces (id, slug, name, description, emoji, kind, visibility, accent, position, created_at, updated_at)
   VALUES (?, 'field-guide', 'The Octavo Field Guide', 'How to write, publish, and host beautiful documentation with Octavo.', '', 'docs', 'public', 'vermilion', 99, ?, ?)`
).run(spaceId, t, t);

const insertPage = (parentId, slug, title, blocks, position) => {
  const pid = id();
  const content = JSON.stringify(blocks);
  const body = text(blocks);
  db.prepare(
    `INSERT INTO pages (id, space_id, parent_id, slug, title, content, content_text, position, published, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(pid, spaceId, parentId, slug, title, content, body, position, t, t);
  db.prepare("INSERT INTO pages_fts (page_id, title, body) VALUES (?, ?, ?)").run(pid, title, body);
  return pid;
};

// ---- pages ----
insertPage(null, "welcome", "Welcome to Octavo", [
  P(T("Octavo is an open-source documentation platform with one conviction: "), T("the reading experience matters as much as the writing experience", { italic: true }), T(". Write in a block editor that feels like Notion. Publish a site that reads like a well-set book.")),
  Q("Most wikis are optimized for putting text in. Octavo is optimized for getting knowledge out."),
  H(2, "Why another docs tool?"),
  P(T("The open-source field splits into two camps. Collaborative wikis are pleasant to write in but publish mediocre reader pages. Static-site generators publish beautifully but require Git, Markdown files, and a developer for every edit. Octavo bridges the two:")),
  LI(T("A real block editor — slash commands, drag handles, tables, images, code.")),
  LI(T("A published view with deliberate typography, a table of contents, and true dark mode.")),
  LI(T("One container, one SQLite file. No Postgres, no Redis, no mail server, no OIDC yak-shaving.")),
  H(2, "The shape of a library"),
  P(T("An Octavo install is a "), T("library", { bold: true }), T(" of "), T("spaces", { bold: true }), T(" — each space is a book on the shelf: product docs, a runbook cookbook, a collection of essays. Pages nest as deep as you need.")),
  H(2, "Get started"),
  NLI(T("Create a space from the library home.")),
  NLI(T("Write pages — everything autosaves as a draft.")),
  NLI(T("Hit "), T("Publish", { bold: true }), T(" when a page is ready for readers.")),
], 1);

insertPage(null, "writing", "Writing & publishing", [
  P(T("Every page starts as a "), T("draft", { bold: true }), T(" — visible only to signed-in writers, marked in the sidebar. Publishing makes it part of the public site and adds it to search.")),
  H(2, "The editor"),
  P(T("Type "), T("/", { code: true }), T(" for the block menu: headings, lists, checklists, quotes, code, tables, images, files. Drag the handle to rearrange. Markdown shortcuts work too — "), T("## ", { code: true }), T("makes a heading, "), T("- ", { code: true }), T("makes a list.")),
  H(2, "Draft to published"),
  CHK(true, "Draft pages keep a URL that follows the title"),
  CHK(true, "Published pages freeze their URL so links never break"),
  CHK(true, "Unpublish any time — the page drops out of search and the public tree"),
  H(2, "Structure"),
  P(T("Pages nest infinitely. Reading order is the tree, depth-first — the same order the "), LINK("space cover", "/field-guide"), T(" lists and the prev/next footers walk.")),
], 2);

insertPage(null, "code", "Code that reads well", [
  P(T("Code blocks are highlighted server-side with Shiki — the same engine VS Code quality comes from — and always set on a dark ground, like a printer's slug. Every block has a copy button.")),
  H(2, "TypeScript"),
  CODE("typescript", `type Space = {\n  slug: string;\n  name: string;\n  pages: Page[];\n};\n\nexport function readingOrder(tree: Page[]): Page[] {\n  // Depth-first walk — the order a book is read.\n  return tree.flatMap((p) => [p, ...readingOrder(p.children)]);\n}`),
  H(2, "Shell"),
  CODE("bash", `# One container, one volume. That's the whole deployment.\ndocker run -d \\\n  -p 3000:3000 \\\n  -v octavo-data:/data \\\n  ghcr.io/octavo/octavo:latest`),
  H(2, "Inline code"),
  P(T("Inline code like "), T("pageTree(spaceId)", { code: true }), T(" sits on a quiet paper chip, sized to the surrounding text.")),
], 3);

insertPage(null, "diagrams", "Diagrams", [
  P(T("Add a code block and set its language to "), T("mermaid", { code: true }), T(" — the published page renders it as a diagram that follows light and dark mode.")),
  H(2, "Flowchart"),
  CODE("mermaid", `flowchart LR\n  W[Write in blocks] --> D{Draft}\n  D -->|publish| P[Published page]\n  P --> S[(FTS5 search)]\n  P --> R[Reader view]\n  R -->|prev / next| R`),
  H(2, "Sequence"),
  CODE("mermaid", `sequenceDiagram\n  participant E as Editor\n  participant A as API\n  participant DB as SQLite\n  E->>A: PATCH /api/pages/:id\n  A->>DB: save + reindex FTS\n  DB-->>A: ok\n  A-->>E: saved (700ms debounce)`),
  H(2, "Tables too"),
  { id: id(), type: "table", props: {}, content: { type: "tableContent", rows: [
    { cells: [[T("Feature")], [T("Wiki.js")], [T("Octavo")]] },
    { cells: [[T("Block editor")], [T("half-integrated")], [T("first-class")]] },
    { cells: [[T("Published typography")], [T("afterthought")], [T("the whole point")]] },
    { cells: [[T("Deploy")], [T("DB required")], [T("one container + SQLite")]] },
  ] }, children: [] },
], 4);

const cookbook = insertPage(null, "cookbook", "Cookbook", [
  P(T("Recipes are short, runnable, and self-contained. This section shows how nested pages read — each recipe is a child page.")),
], 5);

insertPage(cookbook, "docker-deploy", "Recipe: deploy with Docker", [
  P(T("Time: 5 minutes. Serves: your whole team.")),
  H(2, "Ingredients"),
  LI(T("A host with Docker")),
  LI(T("A volume for "), T("/data", { code: true })),
  H(2, "Method"),
  NLI(T("Pull and run the image with a mounted volume.")),
  NLI(T("Open the site — the first visit walks you through creating the admin account.")),
  NLI(T("Back up by copying one file: "), T("/data/octavo.db", { code: true }), T(".")),
  CODE("bash", `docker run -d --name octavo \\\n  -p 3000:3000 \\\n  -v octavo-data:/data \\\n  ghcr.io/octavo/octavo:latest`),
], 1);

insertPage(cookbook, "backup", "Recipe: backups in one line", [
  P(T("Everything — pages, spaces, users, search index — lives in a single SQLite file. Uploads live next to it.")),
  CODE("bash", `sqlite3 /data/octavo.db ".backup /backups/octavo-$(date +%F).db"`),
  Q("If your backup strategy fits in a tweet, you'll actually run it."),
], 2);

console.log("Seeded: The Octavo Field Guide (6 pages)");
