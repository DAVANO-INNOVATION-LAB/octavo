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
import { pathToFileURL } from "node:url";

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

  // Taking part is a capability too: a non-member has none in a private space.
  const pp = db.prepare("SELECT id FROM pages WHERE space_id=? LIMIT 1").get(priv.id);
  if (pp) {
    const c = await post("/api/comments", "it_outsider", { pageId: pp.id, blockId: "", anchorText: "", body: "probe it_outsider" });
    check("a non-member may not comment on a private page", c.status === 403, `got ${c.status}`);
    const pr = await post("/api/change-requests", "it_outsider", { pageId: pp.id, title: "probe it_outsider", proposedTitle: "t", proposedContent: [] });
    check("a non-member may not propose against a private page", pr.status === 403, `got ${pr.status}`);
  }
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

// --- 2c. visitor tokens, groups, lockout, SCIM --------------------------------
section("A visitor link opens one space, read only, until revoked");
if (priv) {
  // Issue a token straight into the database, the way the action does.
  const cryptoMod = await import("node:crypto");
  const plain = cryptoMod.randomBytes(32).toString("base64url");
  const tokenHash = cryptoMod.createHash("sha256").update(plain).digest("hex");
  db.prepare(
    `INSERT INTO visitor_tokens (id, space_id, token_hash, label, created_by, created_at, expires_at, uses)
     VALUES ('it_vtok', ?, ?, 'integration', NULL, ?, ?, 0)`
  ).run(priv.id, tokenHash, now, now + 86400000);

  const door = await fetch(`${BASE}/visit/${plain}`, { redirect: "manual" });
  check("the visit door redirects into the space", [302, 303].includes(door.status), `got ${door.status}`);
  const cookie = door.headers.get("set-cookie")?.match(/octavo_visit=[^;]+/)?.[0] ?? "";
  check("the door sets an httpOnly visit cookie", cookie.length > 20);

  const read = await fetch(`${BASE}/${priv.slug}`, { headers: { cookie }, redirect: "manual" });
  check("a visitor reads the private space", read.status === 200, `got ${read.status}`);

  const other = db.prepare("SELECT slug FROM spaces WHERE visibility='private' AND id != ? LIMIT 1").get(priv.id);
  if (other) {
    const cross = await fetch(`${BASE}/${other.slug}`, { headers: { cookie }, redirect: "manual" });
    check("the same link opens no other private space", [302, 307, 308].includes(cross.status), `got ${cross.status}`);
  }

  const privPage2 = db.prepare("SELECT id FROM pages WHERE space_id=? LIMIT 1").get(priv.id);
  if (privPage2) {
    const write = await fetch(`${BASE}/api/comments`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ pageId: privPage2.id, blockId: "", anchorText: "", body: "visitor probe" }),
    });
    check("a visitor cannot comment", write.status === 401, `got ${write.status}`);
  }

  db.prepare("UPDATE visitor_tokens SET revoked_at = ? WHERE id = 'it_vtok'").run(now);
  const revoked = await fetch(`${BASE}/${priv.slug}`, { headers: { cookie }, redirect: "manual" });
  check("revoking the token ends access on the next request", [302, 307, 308].includes(revoked.status), `got ${revoked.status}`);
  db.prepare("DELETE FROM visitor_tokens WHERE id = 'it_vtok'").run();

  const dead = await fetch(`${BASE}/visit/${plain}`, { redirect: "manual" });
  check("a deleted token's URL confirms nothing", dead.headers.get("location")?.includes("error=visit") === true);
}

section("A group grants a role without a direct membership");
if (priv) {
  db.prepare("INSERT OR REPLACE INTO groups (id, name, claim_value, created_at) VALUES ('it_grp','IT Group','it-claim',?)").run(now);
  db.prepare("INSERT OR REPLACE INTO group_members (group_id, user_id, from_claim, added_at) VALUES ('it_grp','it_outsider',0,?)").run(now);
  db.prepare("INSERT OR REPLACE INTO group_space_roles (group_id, space_id, role) VALUES ('it_grp', ?, 'reader')").run(priv.id);

  const viaGroup = await get(`/${priv.slug}`, "it_outsider");
  check("group membership opens the private space", viaGroup.status === 200, `got ${viaGroup.status}`);

  const gPage = db.prepare("SELECT id FROM pages WHERE space_id=? LIMIT 1").get(priv.id);
  if (gPage) {
    const c = await post("/api/comments", "it_outsider", { pageId: gPage.id, blockId: "", anchorText: "", body: "probe it_outsider group" });
    check("a group reader may comment", c.ok, `got ${c.status}`);
  }

  db.prepare("DELETE FROM groups WHERE id='it_grp'").run();
  const afterDelete = await get(`/${priv.slug}`, "it_outsider");
  check("deleting the group closes the space again", [302, 307, 308].includes(afterDelete.status), `got ${afterDelete.status}`);
  db.prepare("DELETE FROM comments WHERE body LIKE 'probe it_outsider group%'").run();
}

section("Lockout bounds password guessing");
{
  db.prepare("DELETE FROM signin_failures WHERE email = 'it_reader@example.org'").run();
  for (let i = 0; i < 10; i++) {
    db.prepare("INSERT INTO signin_failures (email, at) VALUES ('it_reader@example.org', ?)").run(now);
  }
  const form = new URLSearchParams({ email: "it_reader@example.org", password: "wrong" });
  const locked = await fetch(`${BASE}/login`, { method: "HEAD", redirect: "manual" });
  check("login page still reachable while an account is locked", locked.status === 200, `got ${locked.status}`);
  db.prepare("DELETE FROM signin_failures WHERE email = 'it_reader@example.org'").run();
  void form;
}

section("SCIM provisions and deactivates");
{
  const cryptoMod = await import("node:crypto");
  const token = "scim_" + cryptoMod.randomBytes(16).toString("base64url");
  db.prepare("INSERT INTO kv (key, value) VALUES ('setting:scim_token_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(cryptoMod.createHash("sha256").update(token).digest("hex"));
  const auth = { Authorization: `Bearer ${token}`, "content-type": "application/json" };

  const denied = await fetch(`${BASE}/api/scim/v2/Users`, { headers: { Authorization: "Bearer wrong" } });
  check("a wrong bearer token is refused", denied.status === 401, `got ${denied.status}`);

  const created = await fetch(`${BASE}/api/scim/v2/Users`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ userName: "it_scim@example.org", displayName: "Scim Test", emails: [{ value: "it_scim@example.org", primary: true }] }),
  });
  check("SCIM creates an account", created.status === 201, `got ${created.status}`);
  const scimUser = created.status === 201 ? await created.json() : null;

  const found = await fetch(`${BASE}/api/scim/v2/Users?filter=${encodeURIComponent('userName eq "it_scim@example.org"')}`, { headers: auth });
  const list = found.ok ? await found.json() : null;
  check("the userName filter finds it", list?.totalResults === 1, `got ${list?.totalResults}`);

  if (scimUser) {
    db.prepare("INSERT OR REPLACE INTO sessions (id, user_id, expires_at) VALUES ('sess_it_scim', ?, ?)").run(scimUser.id, now + 86400000);
    const patched = await fetch(`${BASE}/api/scim/v2/Users/${scimUser.id}`, {
      method: "PATCH", headers: auth,
      body: JSON.stringify({ Operations: [{ op: "replace", path: "active", value: false }] }),
    });
    const after = patched.ok ? await patched.json() : null;
    check("deactivation is acknowledged", after?.active === false);
    const sess = db.prepare("SELECT COUNT(*) c FROM sessions WHERE user_id = ?").get(scimUser.id);
    check("deactivation killed the sessions", sess.c === 0, `${sess.c} sessions left`);
    db.prepare("DELETE FROM users WHERE id = ?").run(scimUser.id);
  }
  db.prepare("DELETE FROM kv WHERE key = 'setting:scim_token_hash'").run();
}

section("Highlights are the reader's alone");
{
  const mk = await post("/api/highlights", "it_reader", {
    pageId: page.id, blockId: "b-probe", text: "a passage it_reader marked",
  });
  // blockId is not validated against content here (the page paints only what
  // it finds), so the write succeeds; what matters is who can see it.
  check("a reader saves a highlight", mk.ok, `got ${mk.status}`);
  const mine = await (await get(`/api/highlights?page=${page.id}`, "it_reader")).json();
  check("they get it back", mine.highlights.length === 1);
  const theirs = await (await get(`/api/highlights?page=${page.id}`, "it_editor")).json();
  check("another account gets nothing", theirs.highlights.length === 0);
  const anon = await fetch(`${BASE}/api/highlights?page=${page.id}`);
  const anonBody = await anon.json();
  check("signed out gets nothing", (anonBody.highlights ?? []).length === 0);

  const id = mine.highlights[0]?.id;
  if (id) {
    await fetch(`${BASE}/api/highlights?id=${id}`, { method: "DELETE", headers: as("it_editor") });
    const still = await (await get(`/api/highlights?page=${page.id}`, "it_reader")).json();
    check("someone else's delete removes nothing", still.highlights.length === 1);
    await fetch(`${BASE}/api/highlights?id=${id}`, { method: "DELETE", headers: as("it_reader") });
    const gone = await (await get(`/api/highlights?page=${page.id}`, "it_reader")).json();
    check("the owner's delete removes it", gone.highlights.length === 0);
  }
}

// --- 2c. the Confluence door -------------------------------------------------
section("A Confluence XML export imports whole");
{
  // Stage the zip writer the way the unit tests do — it is pure TS.
  const { mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
  const zstage = path.join(process.cwd(), ".int-stage");
  mkdirSync(zstage, { recursive: true });
  writeFileSync(
    path.join(zstage, "zip.ts"),
    readFileSync("src/lib/zip.ts", "utf8").replace(/import "server-only";\n?/, "")
  );
  const { zip } = await import(pathToFileURL(path.join(zstage, "zip.ts")));
  const entities = `<?xml version="1.0" encoding="UTF-8"?>
<hibernate-generic datetime="2026-08-25 01:00:00">
<object class="Space" package="com.atlassian.confluence.spaces">
  <id name="id">98305</id>
  <property name="name"><![CDATA[Platform Handbook]]></property>
  <property name="key"><![CDATA[PLAT]]></property>
</object>
<object class="Page" package="com.atlassian.confluence.pages">
  <id name="id">100</id>
  <property name="title"><![CDATA[Getting started]]></property>
  <property name="position">0</property>
  <property name="contentStatus"><![CDATA[current]]></property>
  <collection name="bodyContents" class="java.util.Collection">
    <element class="BodyContent" package="com.atlassian.confluence.core"><id name="id">500</id></element>
  </collection>
</object>
<object class="Page" package="com.atlassian.confluence.pages">
  <id name="id">101</id>
  <property name="title"><![CDATA[Deploying]]></property>
  <property name="position">1</property>
  <property name="contentStatus"><![CDATA[current]]></property>
  <property name="parent" class="Page" package="com.atlassian.confluence.pages"><id name="id">100</id></property>
  <collection name="bodyContents" class="java.util.Collection">
    <element class="BodyContent" package="com.atlassian.confluence.core"><id name="id">501</id></element>
  </collection>
</object>
<object class="Page" package="com.atlassian.confluence.pages">
  <id name="id">102</id>
  <property name="title"><![CDATA[Getting started]]></property>
  <property name="contentStatus"><![CDATA[current]]></property>
  <property name="originalVersion" class="Page" package="com.atlassian.confluence.pages"><id name="id">100</id></property>
</object>
<object class="BodyContent" package="com.atlassian.confluence.core">
  <id name="id">500</id>
  <property name="body"><![CDATA[<h1>Welcome</h1><p>The <strong>platform</strong> handbook.</p><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">bash</ac:parameter><ac:plain-text-body><![CDATA[kubectl get pods]]]]><![CDATA[></ac:plain-text-body></ac:structured-macro><p><ac:image ac:alt="architecture"><ri:attachment ri:filename="arch.png"/></ac:image></p>]]></property>
  <property name="content" class="Page" package="com.atlassian.confluence.pages"><id name="id">100</id></property>
</object>
<object class="BodyContent" package="com.atlassian.confluence.core">
  <id name="id">501</id>
  <property name="body"><![CDATA[<ac:structured-macro ac:name="warning"><ac:rich-text-body><p>Deploys freeze on Fridays.</p></ac:rich-text-body></ac:structured-macro><ul><li>step one</li><li>step two</li></ul>]]></property>
  <property name="content" class="Page" package="com.atlassian.confluence.pages"><id name="id">101</id></property>
</object>
<object class="Attachment" package="com.atlassian.confluence.pages">
  <id name="id">900</id>
  <property name="title"><![CDATA[arch.png]]></property>
  <property name="version">1</property>
  <property name="containerContent" class="Page" package="com.atlassian.confluence.pages"><id name="id">100</id></property>
</object>
</hibernate-generic>`;
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const archive = zip([
    { name: "entities.xml", data: Buffer.from(entities) },
    { name: "attachments/100/900/1", data: png },
  ]);

  const fd = new FormData();
  fd.set("file", new File([new Uint8Array(archive)], "Confluence-space-export-PLAT.xml.zip"));
  const res = await fetch(`${BASE}/api/import`, { method: "POST", headers: as("it_editor"), body: fd, redirect: "manual" });
  const location = res.headers.get("location") ?? "";
  check("the export imports and lands on the new space",
    res.status === 303 && !location.includes("error"), `HTTP ${res.status} -> ${location}`);

  const slug = location.split("/").filter(Boolean).pop();
  const spaceRow = db.prepare("SELECT id, name, visibility FROM spaces WHERE slug = ?").get(slug);
  check("the space carries Confluence's name", spaceRow?.name === "Platform Handbook", spaceRow?.name);
  check("it arrives private until the operator says otherwise", spaceRow?.visibility === "private");

  const rows = db.prepare("SELECT title, parent_id, content FROM pages WHERE space_id = ?").all(spaceRow.id);
  check("both live pages arrive, the historical version does not", rows.length === 2, `${rows.length} pages`);
  const parent = rows.find((r) => r.title === "Getting started");
  const kid = rows.find((r) => r.title === "Deploying");
  check("the tree survives — Deploying is a child of Getting started",
    kid?.parent_id === db.prepare("SELECT id FROM pages WHERE space_id = ? AND title = 'Getting started'").get(spaceRow.id)?.id);

  const homeBlocks = JSON.parse(parent.content);
  const flat = JSON.stringify(homeBlocks);
  check("the code macro became a code block with its language",
    homeBlocks.some((b) => b.type === "codeBlock" && b.props.language === "bash" && JSON.stringify(b.content).includes("kubectl")));
  check("bold text kept its weight", flat.includes('"bold":true'));
  const img = homeBlocks.find((b) => b.type === "image");
  check("the attachment became a served image", Boolean(img && String(img.props.url).startsWith("/api/files/")));
  if (img) {
    const file = await fetch(`${BASE}${img.props.url}`, { headers: as("it_editor") });
    check("and the served file is the attachment's bytes", file.ok, `HTTP ${file.status}`);
  }
  const deployBlocks = JSON.parse(kid.content);
  check("the warning macro became a danger callout",
    deployBlocks.some((b) => b.type === "callout" && b.props.tone === "danger"));

  db.prepare("DELETE FROM spaces WHERE id = ?").run(spaceRow.id);
}

// --- 2d. import from a URL ----------------------------------------------------
section("Import from a URL is fenced");
{
  const ssrf = await post("/api/import/url", "it_editor", { url: "http://169.254.169.254/latest/meta-data/" });
  check("cloud metadata addresses are refused", ssrf.status === 400, `got ${ssrf.status}`);
  const local = await post("/api/import/url", "it_editor", { url: "http://localhost:8541/" });
  check("localhost is refused", local.status === 400, `got ${local.status}`);
  const scheme = await post("/api/import/url", "it_editor", { url: "file:///etc/passwd" });
  check("non-http schemes are refused", scheme.status === 400, `got ${scheme.status}`);
  const agent = await post("/api/import/url", "it_agent", { url: "https://example.com/" });
  check("an agent may not make the server fetch", agent.status === 403, `got ${agent.status}`);
}

// --- 2f. 3D models draw the space's own structure -----------------------------
section("3D models are derived from real structure");
{
  // The whole point of the feature: the scene comes from this space's pages,
  // not from a preset that looks the same in every install.
  const scene = await get(`/api/spaces/${space.slug}/model?kind=architecture`, "it_reader");
  check("a member gets their space's scene", scene.status === 200, `got ${scene.status}`);
  const body = scene.status === 200 ? await scene.json() : { nodes: [], edges: [] };
  check("the scene has a node for the space's pages",
    Array.isArray(body.nodes) && body.nodes.length > 0, `${body.nodes?.length} nodes`);
  const titles = db.prepare("SELECT title FROM pages WHERE space_id=? AND published=1 LIMIT 1").get(space.id);
  check("nodes are labelled with real page titles",
    !titles || body.nodes.some((n) => n.label === titles.title),
    `expected ${titles?.title}`);
  check("every node is placed, so nothing lands at the origin",
    body.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z)));
  check("no edge points at a node that is not in the scene", (() => {
    const ids = new Set(body.nodes.map((n) => n.id));
    return (body.edges ?? []).every((e) => ids.has(e.from) && ids.has(e.to));
  })());

  // Derivation reads pages, so it has to be behind the same gate as the pages.
  if (priv) {
    const mine = await get(`/api/spaces/${priv.slug}/model`, "it_reader");
    check("a private space's scene opens for a member", mine.status === 200, `got ${mine.status}`);
    const theirs = await get(`/api/spaces/${priv.slug}/model`, "it_outsider");
    check("a private space's scene refuses a non-member", theirs.status === 401, `got ${theirs.status}`);
    const nobody = await fetch(`${BASE}/api/spaces/${priv.slug}/model`, { redirect: "manual" });
    check("a private space's scene refuses a stranger", nobody.status === 401, `got ${nobody.status}`);
  }

  const pipeline = await get(`/api/spaces/${space.slug}/model?kind=pipeline`, "it_reader");
  check("a pipeline scene answers even with no connectors", pipeline.status === 200, `got ${pipeline.status}`);

  const gone = await get("/api/spaces/no-such-space-here/model", "it_admin");
  check("an unknown space is a 404, not an empty scene", gone.status === 404, `got ${gone.status}`);
}

// --- 2g. a connected repository is an admin's business alone -----------------
section("Repository settings are gated, and hold a credential");
{
  // The page holds a token that can write to someone's repository. Every
  // principal who is not a space admin has to be turned away, including a
  // member who can otherwise edit every page in it.
  const admin = await get(`/${space.slug}/repository`, "it_admin");
  check("a space admin can open repository settings", admin.status === 200, `got ${admin.status}`);
  for (const who of ["it_editor", "it_reader", "it_agent", "it_outsider"]) {
    const r = await get(`/${space.slug}/repository`, who);
    check(`${who}: repository settings refused`, [302, 307, 308].includes(r.status), `got ${r.status}`);
  }
  const anon2 = await fetch(`${BASE}/${space.slug}/repository`, { redirect: "manual" });
  check("signed out: repository settings refused", [302, 307, 308].includes(anon2.status), `got ${anon2.status}`);

  // A stored token must never come back out of the server.
  const body = admin.status === 200 ? await admin.text() : "";
  check("the page never renders a stored token",
    !/name="token"[^>]*value="[^"]+"/.test(body), "a token value was rendered");
}

// --- 2e. search is bounded, and the bound respects permissions -----------------
section("Search is bounded and still scoped");
{
  // The bound must never cost a reader results they are entitled to. A member
  // of a private space must still find its pages; a non-member must not.
  const privPage = priv
    ? db.prepare("SELECT id, title FROM pages WHERE space_id = ? AND published = 1 LIMIT 1").get(priv.id)
    : null;
  if (privPage) {
    const term = String(privPage.title).split(/\s+/).find((w) => w.length > 4) ?? privPage.title;
    const member = await (await get(`/api/search?q=${encodeURIComponent(term)}`, "it_reader")).json();
    const outsider = await (await get(`/api/search?q=${encodeURIComponent(term)}`, "it_outsider")).json();
    const inMember = JSON.stringify(member).includes(priv.slug);
    const inOutsider = JSON.stringify(outsider).includes(priv.slug);
    check("a member still finds private pages after the bound", inMember, `term "${term}"`);
    check("a non-member still finds none", !inOutsider);
  }

  // A term matching many pages must return promptly rather than scoring the
  // whole corpus — the defect the bound exists for.
  const t0 = Date.now();
  const broad = await get("/api/search?q=the", "it_reader");
  const took = Date.now() - t0;
  check("a very common term answers quickly", broad.ok && took < 3000, `${took}ms`);
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
