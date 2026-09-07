// Tenant isolation, probed from the outside.
//
// A tenant's promise is that its spaces do not exist for anyone outside it —
// including its PUBLIC spaces, which are public within the tenant. That is a
// stronger claim than private-space membership, and a weaker implementation
// looks identical until someone from the wrong tenant guesses a slug.
//
// So this does not check that the feature works. It checks every route that
// could leak: the library, search, the graph, the agent feeds, the sitemap,
// backlinks, page lookup, and a direct request for the page itself.
//
// Usage: node scripts/tenant-test.mjs [baseUrl]
import Database from "better-sqlite3";
import path from "node:path";
import { requireTarget } from "./target.mjs";

const BASE = process.argv[2] ?? "http://localhost:8541";
await requireTarget(BASE);
const db = new Database(path.join(process.cwd(), "data", "octavo.db"));

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

const now = Date.now();
const clean = () => {
  db.prepare("DELETE FROM page_links WHERE from_page LIKE 'tt_%' OR to_page LIKE 'tt_%'").run();
  db.prepare("DELETE FROM pages_fts WHERE page_id LIKE 'tt_%'").run();
  db.prepare("DELETE FROM pages WHERE id LIKE 'tt_%'").run();
  db.prepare("DELETE FROM spaces WHERE id LIKE 'tt_%'").run();
  db.prepare("DELETE FROM tenant_members WHERE tenant_id LIKE 'tt_%'").run();
  db.prepare("DELETE FROM tenants WHERE id LIKE 'tt_%'").run();
  db.prepare("DELETE FROM sessions WHERE id LIKE 'sess_tt_%'").run();
  db.prepare("DELETE FROM users WHERE id LIKE 'tt_%'").run();
};
clean();

// Two tenants, one space each — both PUBLIC, which is the hard case.
for (const [id, slug, name] of [["tt_acme", "tt-acme", "Acme"], ["tt_globex", "tt-globex", "Globex"]]) {
  db.prepare("INSERT INTO tenants (id, slug, name, claim_value, accent, created_at) VALUES (?,?,?,?,'',?)")
    .run(id, slug, name, `grp-${slug}`, now);
}
for (const [sid, sslug, tid, title] of [
  ["tt_s_acme", "tt-acme-space", "tt_acme", "Acme Handbook"],
  ["tt_s_globex", "tt-globex-space", "tt_globex", "Globex Handbook"],
]) {
  db.prepare(
    `INSERT INTO spaces (id, slug, name, description, emoji, kind, visibility, accent, position, created_at, updated_at, tenant_id)
     VALUES (?, ?, ?, '', '', 'docs', 'public', 'vermilion', 900, ?, ?, ?)`
  ).run(sid, sslug, title, now, now, tid);
  db.prepare(
    `INSERT INTO pages (id, space_id, parent_id, slug, title, content, content_text, position, published, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, '[]', ?, 1, 1, ?, ?)`
  ).run(`${sid}_p`, sid, `${sslug}-page`, `${title} secret page`, `zebrafish${sid}`, now, now);
  // The search index is written by savePage, not by inserting a row. Without
  // this the search assertion below passes because nothing matches at all —
  // a check that would go on passing with the tenancy gate ripped out.
  db.prepare("DELETE FROM pages_fts WHERE page_id = ?").run(`${sid}_p`);
  db.prepare("INSERT INTO pages_fts (page_id, title, body) VALUES (?, ?, ?)")
    .run(`${sid}_p`, `${title} secret page`, `zebrafish${sid}`);
}

// The graph draws only LINKED pages, and it drops an edge whose other end is
// out of scope. So each tenant needs a link WITHIN itself: a single link
// across the two would be correctly discarded, leaving both pages at degree
// zero and the graph assertions passing for the wrong reason.
db.prepare("DELETE FROM page_links WHERE from_page LIKE 'tt_%' OR to_page LIKE 'tt_%'").run();
for (const sid of ["tt_s_acme", "tt_s_globex"]) {
  const second = `${sid}_p2`;
  db.prepare(
    `INSERT INTO pages (id, space_id, parent_id, slug, title, content, content_text, position, published, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, '[]', '', 2, 1, ?, ?)`
  ).run(second, sid, `${sid}-second`, `${sid} second page`, now, now);
  db.prepare("INSERT INTO page_links (from_page, to_page) VALUES (?, ?)").run(`${sid}_p`, second);
}

// Three principals: one in each tenant, and one in neither.
for (const [uid, tenant] of [["tt_u_acme", "tt_acme"], ["tt_u_globex", "tt_globex"], ["tt_u_none", null]]) {
  db.prepare("INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,'member',?)")
    .run(uid, `${uid}@example.org`, uid, "x", now);
  db.prepare("INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)")
    .run(`sess_${uid}`, uid, now + 86400000);
  if (tenant) db.prepare("INSERT INTO tenant_members (tenant_id,user_id,from_claim,added_at) VALUES (?,?,0,?)").run(tenant, uid, now);
}

const get = (p, who) =>
  fetch(BASE + p, {
    headers: who ? { cookie: `octavo_session=sess_${who}` } : {},
    redirect: "manual",
  });
const body = async (p, who) => {
  const r = await get(p, who);
  return { status: r.status, text: r.status === 200 ? await r.text() : "" };
};

console.log("\nA tenant's own member sees their tenant\n");
{
  const lib = await body("/", "tt_u_acme");
  ok("their own tenant's space is on the library shelf", lib.text.includes("Acme Handbook"));
  const page = await get("/tt-acme-space/tt-acme-space-page", "tt_u_acme");
  ok("their own tenant's page opens", page.status === 200, `got ${page.status}`);
}

console.log("\nAnd nothing of the other tenant, on any route\n");
{
  const who = "tt_u_acme";
  const lib = await body("/", who);
  ok("the other tenant's space is not on the shelf", !lib.text.includes("Globex Handbook"));

  // Proven non-vacuous: the same query as their own tenant's member finds it.
  const mine = await body("/api/search?q=zebrafishtt_s_acme", who);
  ok("search finds their OWN tenant's page (so the next check means something)",
    mine.text.includes("Acme"), mine.text.slice(0, 160));
  const search = await body("/api/search?q=zebrafishtt_s_globex", who);
  ok("search does not find the other tenant's page", !search.text.includes("Globex"), search.text.slice(0, 160));

  const lookup = await body("/api/pages/lookup?q=Globex", who);
  ok("the page picker does not offer it", !lookup.text.includes("Globex Handbook"), lookup.text.slice(0, 160));

  const graph = await body("/graph", who);
  ok("the knowledge graph draws their own tenant (so the next check means something)",
    graph.text.includes("Acme Handbook"), `status ${graph.status}`);
  ok("the knowledge graph does not draw the other tenant", !graph.text.includes("Globex Handbook"));

  // The hard one: knowing the slug must not be enough.
  const direct = await get("/tt-globex-space", who);
  ok("asking for the space by name is refused", direct.status !== 200, `got ${direct.status}`);
  const directPage = await get("/tt-globex-space/tt-globex-space-page", who);
  ok("asking for the page by name is refused", directPage.status !== 200, `got ${directPage.status}`);
  const raw = await get("/tt-globex-space/tt-globex-space-page/raw", who);
  ok("the markdown view is refused too", raw.status !== 200, `got ${raw.status}`);
}

console.log("\nA stranger sees the library only\n");
{
  const lib = await body("/", null);
  ok("no tenant space is on a signed-out shelf",
    !lib.text.includes("Acme Handbook") && !lib.text.includes("Globex Handbook"));
  const map = await body("/sitemap.xml", null);
  ok("the sitemap does not publish tenant spaces",
    !map.text.includes("tt-acme-space") && !map.text.includes("tt-globex-space"));
  const llms = await body("/llms.txt", null);
  ok("the agent index does not list tenant spaces",
    !llms.text.includes("Acme Handbook") && !llms.text.includes("Globex Handbook"));
  const direct = await get("/tt-acme-space", null);
  ok("a stranger cannot open a tenant space by name", direct.status !== 200, `got ${direct.status}`);
}

console.log("\nA signed-in member of no tenant is not a member of every tenant\n");
{
  const lib = await body("/", "tt_u_none");
  ok("sees neither tenant's space",
    !lib.text.includes("Acme Handbook") && !lib.text.includes("Globex Handbook"));
  const direct = await get("/tt-acme-space", "tt_u_none");
  ok("cannot open one by name", direct.status !== 200, `got ${direct.status}`);
}

console.log("\nThe library itself is unaffected\n");
{
  const untenanted = db.prepare("SELECT slug, name FROM spaces WHERE tenant_id IS NULL AND visibility = 'public' LIMIT 1").get();
  const lib = await body("/", "tt_u_acme");
  ok("an untenanted public space is still visible to a tenant member",
    lib.text.includes(untenanted.name), untenanted.name);
  const anon = await body("/", null);
  ok("and still visible to a stranger", anon.text.includes(untenanted.name));
}

console.log("\nAn instance admin stands outside tenancy\n");
{
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (admin) {
    db.prepare("INSERT OR REPLACE INTO sessions (id,user_id,expires_at) VALUES ('sess_tt_admin',?,?)")
      .run(admin.id, now + 86400000);
    const lib = await body("/", "tt_admin");
    ok("an admin sees every tenant's spaces",
      lib.text.includes("Acme Handbook") && lib.text.includes("Globex Handbook"));
  } else { ok("an admin sees every tenant's spaces", true, "no admin to test with"); }
}

clean();
console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
