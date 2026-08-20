// Seeds a realistic 30-page demo knowledge graph: two hubs, three clusters,
// a reference chain, and cross-space bridges — the shape a real library takes.
// Usage: node scripts/seed-graph-demo.mjs
import Database from "better-sqlite3";
import path from "node:path";

const db = new Database(path.join(process.cwd(), "data", "octavo.db"));
db.prepare("DELETE FROM page_links").run();

const q = (space, n, off = 0) =>
  db
    .prepare(
      `SELECT p.id, p.title FROM pages p JOIN spaces s ON s.id = p.space_id
       WHERE s.slug = ? AND p.published = 1 ORDER BY p.position LIMIT ? OFFSET ?`
    )
    .all(space, n, off);

const guide = q("field-guide", 8);
const k8s = q("ops-kubernetes", 7);
const air = q("ops-airflow", 5);
const jup = q("ops-jupyter", 4);
const rfc = q("rfc-reading-room", 6);
const all = [...guide, ...k8s, ...air, ...jup, ...rfc];

const ins = db.prepare(
  "INSERT OR IGNORE INTO page_links (from_page, to_page) VALUES (?, ?)"
);
let n = 0;
const link = (a, b) => {
  if (a && b && a.id !== b.id) {
    ins.run(a.id, b.id);
    n++;
  }
};

// Hub 1 — the front door: most pages cite it.
[...guide.slice(1), k8s[0], air[0], jup[0], rfc[0]].forEach((p) =>
  link(p, guide[0])
);

// Hub 2 — the deploy recipe every ops page references.
[...k8s.slice(1), air[1], jup[1]].forEach((p) => link(p, k8s[0]));

// Kubernetes cluster: dense internal mesh.
k8s.forEach((p, i) => {
  link(p, k8s[(i + 1) % k8s.length]);
  if (i % 2) link(p, k8s[(i + 3) % k8s.length]);
});

// Airflow cluster: a ring with one chord.
air.forEach((p, i) => link(p, air[(i + 1) % air.length]));
link(air[0], air[3]);

// Jupyter: a small star around its first page.
jup.slice(1).forEach((p) => link(p, jup[0]));

// RFCs: a citation chain, oldest to newest.
rfc.forEach((p, i) => link(p, rfc[(i + 1) % rfc.length]));

// Bridges between neighbourhoods — what makes a graph worth looking at.
link(k8s[1], air[0]);
link(air[2], jup[0]);
link(jup[2], rfc[1]);
link(rfc[3], guide[2]);
link(guide[4], k8s[2]);

console.log(`Seeded a demo graph: ${all.length} pages, ${n} links`);
console.log(`  hubs: "${guide[0].title}" and "${k8s[0].title}"`);
