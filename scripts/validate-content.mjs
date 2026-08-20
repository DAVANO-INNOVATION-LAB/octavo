// Guard against the failure the editor cannot recover from: content in the
// database whose block types, props, or styles the editor's schema rejects.
// A page that renders fine for readers can still be un-editable, so check
// every page against the schema's own vocabulary.
// Usage: node scripts/validate-content.mjs
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";

const db = new Database(path.join(process.cwd(), "data", "octavo.db"));
const src = readFileSync("src/components/editor/customBlocks.tsx", "utf8");

// Block types the schema registers on top of BlockNote's defaults.
const custom = [...src.matchAll(/^\s{4}(\w+):\s*\w+\(\),$/gm)].map((m) => m[1]);
const DEFAULT_BLOCKS = [
  "paragraph", "heading", "bulletListItem", "numberedListItem",
  "checkListItem", "quote", "codeBlock", "table", "image", "video",
  "audio", "file", "pageBreak", "toggleListItem",
];
const KNOWN_BLOCKS = new Set([...DEFAULT_BLOCKS, ...custom]);

// Styles the schema registers beyond the defaults.
const customStyles = [...src.matchAll(/^\s{4}(\w+):\s*\w+,$/gm)].map((m) => m[1]);
const KNOWN_STYLES = new Set([
  "bold", "italic", "underline", "strike", "code",
  "textColor", "backgroundColor",
  ...customStyles,
]);

const problems = [];
const pages = db
  .prepare(
    `SELECT p.id, p.title, p.slug, p.content, s.slug AS space
     FROM pages p JOIN spaces s ON s.id = p.space_id`
  )
  .all();

for (const page of pages) {
  let blocks;
  try {
    blocks = JSON.parse(page.content);
  } catch {
    problems.push({ page, what: "content is not valid JSON" });
    continue;
  }
  const walk = (list) => {
    for (const b of list ?? []) {
      if (!KNOWN_BLOCKS.has(b.type))
        problems.push({ page, what: `unknown block type "${b.type}"` });
      const inline = (content) => {
        if (!Array.isArray(content)) return;
        for (const n of content) {
          for (const style of Object.keys(n?.styles ?? {})) {
            if (!KNOWN_STYLES.has(style))
              problems.push({ page, what: `unknown style "${style}"` });
          }
          if (n?.content) inline(n.content);
        }
      };
      inline(b.content);
      if (b.children?.length) walk(b.children);
    }
  };
  walk(blocks);
}

console.log(`checked ${pages.length} pages`);
console.log(`known blocks: ${[...KNOWN_BLOCKS].join(", ")}`);
console.log(`known styles: ${[...KNOWN_STYLES].join(", ")}`);

if (!problems.length) {
  console.log("\nEvery page loads in the editor's schema.");
  process.exit(0);
}
const seen = new Map();
for (const p of problems) {
  const key = `${p.what}`;
  if (!seen.has(key)) seen.set(key, []);
  seen.get(key).push(`/${p.page.space}/${p.page.slug}`);
}
console.log(`\n${problems.length} problem(s):`);
for (const [what, where] of seen) {
  console.log(`  ${what} — ${where.length} page(s)`);
  where.slice(0, 5).forEach((w) => console.log(`      ${w}`));
}
process.exit(1);
