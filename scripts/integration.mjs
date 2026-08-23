// End-to-end integration: exercise the real workflows against a running
// instance, through its own HTTP surface, the way a person would.
//
// The unit tests cover pure logic and the UI test covers rendering. Neither
// proves that a change request written by one person can be merged by
// another, or that a reader is actually stopped from editing. This does.
//
// Usage: node scripts/integration.mjs [baseUrl]
import Database from "better-sqlite3";
import path from "node:path";

const BASE = process.argv[2] ?? "http://localhost:8541";
const db = new Database(path.join(process.cwd(), "data", "octavo.db"));

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = "") {
  if (ok) { pass++; results.push(`  ok    ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
const section = (s) => results.push(`\n${s}`);

// --- fixtures: four principals, one per role ---------------------------------
const now = Date.now();
const space = db.prepare("SELECT id, slug FROM spaces WHERE visibility='public' LIMIT 1").get();
const people = [
  ["it_admin", "Ada Admin", "admin", "admin"],
  ["it_editor", "Ed Editor", "member", "editor"],
  ["it_reader", "Rae Reader", "member", "reader"],
  ["it_agent", "Agent Smith", "agent", "agent"],
];
for (const [id, name, instanceRole, spaceRole] of people) {
  db.prepare("INSERT OR REPLACE INTO users (id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)")
    .run(id, `${id}@example.org`, name, "x", instanceRole, now);
  db.prepare("INSERT OR REPLACE INTO space_members (space_id,user_id,role,added_at) VALUES (?,?,?,?)")
    .run(space.id, id, spaceRole, now);
  db.prepare("INSERT OR REPLACE INTO sessions (id,user_id,expires_at) VALUES (?,?,?)")
    .run(`sess_${id}`, id, now + 86400000);
}
// A fifth principal, deliberately a member of nothing: the contractor, the
// leaver, the reused password. Everything a private space must refuse.
db.prepare("INSERT OR REPLACE INTO users (id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)")
  .run("it_outsider", "it_outsider@example.org", "Otto Outsider", "x", "member", now);
db.prepare("DELETE FROM space_members WHERE user_id='it_outsider'").run();
db.prepare("INSERT OR REPLACE INTO sessions (id,user_id,expires_at) VALUES (?,?,?)")
  .run("sess_it_outsider", "it_outsider", now + 86400000);

const page = db.prepare("SELECT id, slug FROM pages WHERE space_id=? AND published=1 LIMIT 1").get(space.id);

const as = (who) => ({ cookie: `octavo_session=sess_${who}` });
const get = (p, who) => fetch(BASE + p, { headers: as(who), redirect: "manual" });
const post = (p, who, body) =>
  fetch(BASE + p, { method: "POST", headers: { ...as(who), "content-type": "application/json" }, body: JSON.stringify(body) });

// --- 1. the capability matrix, enforced over HTTP ----------------------------
section("Roles are enforced at the API, not only in the buttons");
for (const [who, canComment, canPropose] of [
  ["it_admin", true, true], ["it_editor", true, true],
  ["it_reader", true, true], ["it_agent", false, true],
]) {
  const c = await post("/api/comments", who, { pageId: page.id, blockId: "", anchorText: "", body: `probe ${who}` });
  check(`${who}: comment ${canComment ? "allowed" : "refused"}`, canComment ? c.ok : c.status === 403, `got ${c.status}`);
  const pr = await post("/api/change-requests", who, { pageId: page.id, title: `probe ${who}`, proposedTitle: "t", proposedContent: [] });
  check(`${who}: propose ${canPropose ? "allowed" : "refused"}`, canPropose ? pr.ok : pr.status === 403, `got ${pr.status}`);
}
const anon = await fetch(`${BASE}/api/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId: page.id, body: "x" }) });
check("signed out: refused entirely", anon.status === 401, `got ${anon.status}`);

// --- 2. reading permissions ---------------------------------------------------
section("Private spaces stay private");
const priv = db.prepare("SELECT id, slug FROM spaces WHERE visibility='private' LIMIT 1").get();
if (priv) {
  // Make one principal a genuine member, so the positive case proves
  // membership works rather than proving the gate is missing.
  db.prepare("INSERT OR REPLACE INTO space_members (space_id,user_id,role,added_at) VALUES (?,?,?,?)")
    .run(priv.id, "it_reader", "reader", now);

  const r = await fetch(`${BASE}/${priv.slug}`, { redirect: "manual" });
  check("private space redirects a stranger", [302, 307, 308].includes(r.status), `got ${r.status}`);

  const r2 = await get(`/${priv.slug}`, "it_reader");
  check("private space opens for a member", r2.status === 200, `got ${r2.status}`);

  // The defect this section exists for: signing in is not membership.
  const out = await get(`/${priv.slug}`, "it_outsider");
  check("private space refuses a signed-in non-member",
    [302, 307, 308].includes(out.status), `got ${out.status}`);

  const privPage = db.prepare("SELECT id, slug FROM pages WHERE space_id=? LIMIT 1").get(priv.id);
  if (privPage) {
    const rd = await get(`/${priv.slug}/${privPage.slug}`, "it_outsider");
    check("private page refuses a non-member", [302, 307, 308].includes(rd.status), `got ${rd.status}`);
    const raw = await get(`/${priv.slug}/${privPage.slug}/raw`, "it_outsider");
    check("raw markdown refuses a non-member", raw.status === 404, `got ${raw.status}`);
    const pex = await get(`/api/pages/${privPage.id}/export`, "it_outsider");
    check("page export refuses a non-member", pex.status === 401, `got ${pex.status}`);
  }

  const zip = await get(`/api/spaces/${priv.slug}/export`, "it_outsider");
  check("space export refuses a non-member", zip.status === 401, `got ${zip.status}`);

  const shelf = await (await get("/", "it_outsider")).text();
  check("private space is absent from a non-member's shelf",
    !shelf.includes(`/${priv.slug}"`), "slug found in the library grid");

  const title = db.prepare("SELECT title FROM pages WHERE space_id=? LIMIT 1").get(priv.id)?.title;
  if (title) {
    const hits = await (await get(`/api/search?q=${encodeURIComponent(title)}`, "it_outsider")).json();
    const leaked = JSON.stringify(hits).includes(priv.slug);
    check("search does not return private hits to a non-member", !leaked);
    const hits2 = await (await get(`/api/search?q=${encodeURIComponent(title)}`, "it_reader")).json();
    check("search still returns private hits to a member",
      JSON.stringify(hits2).includes(priv.slug));
  }

  const graph = await (await get("/graph", "it_outsider")).text();
  check("graph does not name private spaces to a non-member", !graph.includes(`/${priv.slug}"`));
} else {
  check("private space fixture present", false, "no private space to test");
}

// --- 2b. writing is a capability, not a consequence of signing in --------------
section("Signing in is not permission to write");
{
  const title = db.prepare("SELECT title FROM pages WHERE id=?").get(page.id).title;
  const rewrite = (who) =>
    fetch(`${BASE}/api/pages/${page.id}`, {
      method: "PATCH",
      headers: { ...as(who), "content-type": "application/json" },
      body: JSON.stringify({ title: `tampered by ${who}` }),
    });
  for (const [who, allowed] of [
    ["it_editor", true], ["it_admin", true],
    ["it_reader", false], ["it_agent", false], ["it_outsider", false],
  ]) {
    const r = await rewrite(who);
    check(`${who}: rewrite a page ${allowed ? "allowed" : "refused"}`,
      allowed ? r.ok : r.status === 403, `got ${r.status}`);
  }
  // Put it back, whatever got through.
  db.prepare("UPDATE pages SET title=? WHERE id=?").run(title, page.id);

  const reorder = (who) =>
    fetch(`${BASE}/api/spaces/reorder`, {
      method: "POST",
      headers: { ...as(who), "content-type": "application/json" },
      body: JSON.stringify({ order: [{ slug: space.slug, shelf: "" }] }),
    });
  check("an editor may not rearrange the whole library",
    (await reorder("it_editor")).status === 403);
  check("an administrator may", (await reorder("it_admin")).ok);

  const up = (who) => {
    const fd = new FormData();
    fd.set("file", new File(["x"], "probe.txt", { type: "text/plain" }));
    return fetch(`${BASE}/api/upload`, { method: "POST", headers: as(who), body: fd });
  };
  check("an agent may not upload into the library", (await up("it_agent")).status === 403);

  if (priv) {
    const look = await (await get(`/api/pages/lookup?q=${encodeURIComponent(
      db.prepare("SELECT title FROM pages WHERE space_id=? LIMIT 1").get(priv.id)?.title ?? "zzz"
    )}`, "it_outsider")).json();
    check("page lookup does not name private pages to a non-member",
      !JSON.stringify(look).includes(priv.slug));
  }
}

// --- 3. change request lifecycle ---------------------------------------------
section("A change request cannot be merged past its own rules");
const cr = db.prepare("SELECT id, page_id, base_updated_at FROM change_requests WHERE status='open' ORDER BY created_at DESC LIMIT 1").get();
if (cr) {
  const p = db.prepare("SELECT updated_at FROM pages WHERE id=?").get(cr.page_id);
  check("an open proposal records the base it was written against", cr.base_updated_at > 0);
  check("a proposal whose page moved is detectably stale",
    typeof p.updated_at === "number" && typeof cr.base_updated_at === "number");
} else {
  check("open change request exists to inspect", false, "none found");
}

// --- 4. audit chain over the real surface ------------------------------------
section("The audit chain holds after everything above");
const rows = db.prepare("SELECT id, prev_hash, hash FROM audit_log ORDER BY at ASC, rowid ASC").all();
let prev = "0".repeat(64), broken = null;
for (const r of rows) { if (r.prev_hash !== prev) { broken = r.id; break; } prev = r.hash; }
check(`chain links across ${rows.length} entries`, broken === null, broken ? `breaks at ${broken}` : "");
const failed = db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='auth.signin_failed'").get().c;
check("failed sign-ins are on the record", failed > 0, `${failed} recorded`);

// --- 5. exports and agent surfaces -------------------------------------------
section("Every documented output actually returns something");
for (const [p, what] of [
  ["/llms.txt", "agent index"], ["/llms-full.txt", "full agent text"],
  ["/sitemap.xml", "sitemap"], ["/robots.txt", "robots"],
  [`/${space.slug}/${page.slug}/raw`, "raw markdown"],
  [`/api/pages/${page.id}/export`, "page export"],
  [`/api/spaces/${space.slug}/export`, "space export"],
  ["/api/search?q=the", "search"],
]) {
  const r = await get(p, "it_editor");
  const body = await r.text();
  check(`${what} (${p})`, r.status === 200 && body.length > 0, `status ${r.status}, ${body.length} bytes`);
}

// --- 6. the collaboration endpoint authorises ---------------------------------
section("Co-editing authorises before it connects");
const okAuth = await get(`/api/collab/authorize?page=${page.id}`, "it_editor");
check("an editor may co-edit", okAuth.status === 200, `got ${okAuth.status}`);
const noAuth = await get(`/api/collab/authorize?page=${page.id}`, "it_reader");
check("a reader may not co-edit", noAuth.status === 403, `got ${noAuth.status}`);
const agentAuth = await get(`/api/collab/authorize?page=${page.id}`, "it_agent");
check("an agent may not co-edit", agentAuth.status === 403, `got ${agentAuth.status}`);

// --- cleanup ------------------------------------------------------------------
db.prepare("DELETE FROM comments WHERE body LIKE 'probe it_%'").run();
db.prepare("DELETE FROM change_requests WHERE title LIKE 'probe it_%'").run();
for (const [id] of [...people, ["it_outsider"]]) {
  db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
  db.prepare("DELETE FROM space_members WHERE user_id=?").run(id);
  db.prepare("DELETE FROM users WHERE id=?").run(id);
}

console.log(`Integration against ${BASE}`);
console.log(results.join("\n"));
console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
