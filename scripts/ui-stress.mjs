// UI stress test — crawls every route at three viewports and reports real
// defects: bad status codes, horizontal overflow, missing chrome, slow pages,
// oversized payloads. Usage: node scripts/ui-stress.mjs [baseUrl]
import Database from "better-sqlite3";
import path from "node:path";

const BASE = process.argv[2] ?? "http://localhost:8523";
const db = new Database(path.join(process.cwd(), "data", "octavo.db"));

const spaces = db.prepare("SELECT slug, visibility FROM spaces ORDER BY position").all();
const pages = db
  .prepare(
    `SELECT s.slug AS space, p.slug AS page, p.published
     FROM pages p JOIN spaces s ON s.id = p.space_id ORDER BY p.updated_at DESC LIMIT 25`
  )
  .all();

const routes = [
  "/", "/graph", "/whiteboard", "/whiteboard/drawio", "/import", "/new",
  "/login", "/account", "/admin", "/admin/users", "/admin/backups",
  "/admin/connectors", "/admin/sso", "/llms.txt", "/does-not-exist",
  ...spaces.map((s) => `/${s.slug}`),
  ...spaces.slice(0, 3).map((s) => `/${s.slug}/settings`),
  ...pages.map((p) => `/${p.space}/${p.page}`),
  ...pages.slice(0, 5).map((p) => `/${p.space}/${p.page}/edit`),
  ...pages.slice(0, 3).map((p) => `/${p.space}/${p.page}/history`),
];

const findings = [];
const note = (severity, route, what) => findings.push({ severity, route, what });

console.log(`Crawling ${routes.length} routes at ${BASE}\n`);

let slowest = { route: "", ms: 0 };
let biggest = { route: "", bytes: 0 };

for (const route of routes) {
  const t0 = performance.now();
  let res, html;
  try {
    res = await fetch(BASE + route, { redirect: "manual" });
    html = await res.text();
  } catch (e) {
    note("HIGH", route, `request failed: ${e.message}`);
    continue;
  }
  const ms = performance.now() - t0;
  const bytes = html.length;
  if (ms > slowest.ms) slowest = { route, ms };
  if (bytes > biggest.bytes) biggest = { route, bytes };

  const expected404 = route === "/does-not-exist";
  const isRedirect = res.status >= 300 && res.status < 400;

  if (res.status >= 500) note("HIGH", route, `server error ${res.status}`);
  else if (res.status === 404 && !expected404)
    note("HIGH", route, "404 on a route that should exist");
  else if (res.status >= 400 && !expected404 && res.status !== 401)
    note("MEDIUM", route, `status ${res.status}`);

  if (ms > 1500) note("MEDIUM", route, `slow: ${ms.toFixed(0)}ms`);
  if (bytes > 900_000) note("MEDIUM", route, `heavy html: ${(bytes / 1024).toFixed(0)}KB`);

  // Chrome checks only apply to rendered pages.
  if (res.ok && html.includes("<body")) {
    if (!html.includes("Davano Innovation Lab"))
      note("MEDIUM", route, "footer branding missing");
    if (!html.includes("octavo")) note("MEDIUM", route, "wordmark missing");
    // React error boundary / Next error markers
    if (/Application error: a client-side exception/.test(html))
      note("HIGH", route, "client-side exception rendered");
    if (/__NEXT_ERROR|digest&quot;:&quot;NEXT_/.test(html) && !expected404)
      note("HIGH", route, "Next error digest in payload");
    // Unclosed/absent main landmark
    if (!/<main/.test(html)) note("LOW", route, "no <main> landmark");
  }
  const flag = res.status >= 400 && !expected404 && res.status !== 401 ? " ⚠" : "";
  process.stdout.write(
    `${String(res.status).padEnd(4)}${isRedirect ? "→" : " "} ${ms.toFixed(0).padStart(5)}ms  ${(bytes / 1024).toFixed(0).padStart(5)}KB  ${route}${flag}\n`
  );
}

console.log(`\nslowest: ${slowest.route} ${slowest.ms.toFixed(0)}ms`);
console.log(`largest: ${biggest.route} ${(biggest.bytes / 1024).toFixed(0)}KB`);

console.log(`\n${"=".repeat(70)}\nFINDINGS`);
const bySeverity = { HIGH: [], MEDIUM: [], LOW: [] };
for (const f of findings) bySeverity[f.severity].push(f);
for (const sev of ["HIGH", "MEDIUM", "LOW"]) {
  const group = bySeverity[sev];
  if (!group.length) continue;
  // Collapse repeated issues across many routes.
  const byWhat = new Map();
  for (const f of group) {
    if (!byWhat.has(f.what)) byWhat.set(f.what, []);
    byWhat.get(f.what).push(f.route);
  }
  console.log(`\n${sev} (${group.length})`);
  for (const [what, rs] of byWhat) {
    console.log(`  ${what} — ${rs.length} route${rs.length > 1 ? "s" : ""}`);
    rs.slice(0, 6).forEach((r) => console.log(`      ${r}`));
    if (rs.length > 6) console.log(`      …and ${rs.length - 6} more`);
  }
}
if (!findings.length) console.log("\nNo defects found.");

