// Breaking test: try to make the app misbehave, not confirm that it behaves.
//
// The other suites walk the happy path. This one is adversarial — malformed
// input, injection, oversized bodies, boundary abuse, concurrency, and the
// new attack surface (URL-import SSRF, the composition engine, cookies). A
// pass here means the app FAILED SAFELY at every probe: it rejected, clamped,
// or errored cleanly, and never 500'd on hostile input, leaked across a
// permission boundary, or corrupted its own state.
//
// Usage: node scripts/breaking-test.mjs [baseUrl]
import Database from "better-sqlite3";
import path from "node:path";

const BASE = process.argv[2] ?? "http://localhost:8523";
const db = new Database(path.join(process.cwd(), "data", "octavo.db"));

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; process.stdout.write(`  ok   ${name}\n`); }
  else { fail++; fails.push(`${name}${detail ? ` — ${detail}` : ""}`); process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ""}\n`); }
}
const section = (s) => console.log(`\n${s}`);

// Self-seeding: the four role principals, created fresh so this test is
// idempotent — its own cleanup deletes them, and a second run must not fail
// on their absence.
{
  const now = Date.now();
  const sp = db.prepare("SELECT id FROM spaces WHERE visibility='public' LIMIT 1").get();
  for (const [id, ir, sr] of [["st_admin","admin","admin"],["st_editor","member","editor"],["st_reader","member","reader"],["st_agent","agent","agent"]]) {
    db.prepare("INSERT OR REPLACE INTO users (id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)").run(id, id+"@x.org", id, "x", ir, now);
    db.prepare("INSERT OR REPLACE INTO space_members (space_id,user_id,role,added_at) VALUES (?,?,?,?)").run(sp.id, id, sr, now);
    db.prepare("INSERT OR REPLACE INTO sessions (id,user_id,expires_at) VALUES (?,?,?)").run("sess_"+id, id, now + 86400000);
  }
}

const as = (who) => ({ cookie: `octavo_session=sess_${who}` });
const page = db.prepare("SELECT id FROM pages WHERE published=1 LIMIT 1").get();

// A response that is a clean rejection: any 4xx, or a redirect to login/error.
const cleanReject = (status) => status >= 400 && status < 500;
const notServerError = (status) => status !== 500 && status !== 502 && status !== 503;

async function hit(method, p, opts = {}) {
  try {
    const res = await fetch(BASE + p, { method, redirect: "manual", ...opts });
    return res;
  } catch (e) {
    return { status: 0, text: async () => String(e), _networkError: true };
  }
}

console.log(`Breaking test against ${BASE}`);
console.log("A pass = failed safely. No 500s, no leaks, no corruption.\n");

/* ═══ 1. Malformed bodies never crash a route ═══ */
section("Malformed request bodies fail cleanly, never 500");
{
  const garbage = [
    "not json at all",
    "{unclosed",
    '{"deeply":' .repeat(500) + "null" + "}".repeat(500), // deep nesting
    JSON.stringify({ pageId: { $ne: null } }), // NoSQL-ish object where string expected
    JSON.stringify([1, 2, 3]), // array where object expected
    "",
    "null",
    "true",
    '{"pageId":"' + "A".repeat(100000) + '"}', // 100KB string field
  ];
  const routes = [
    ["POST", "/api/comments"],
    ["POST", "/api/change-requests"],
    ["POST", "/api/highlights"],
    ["POST", "/api/reading"],
    ["POST", "/api/import/url"],
    ["PATCH", `/api/pages/${page.id}`],
    ["POST", "/api/spaces/reorder"],
  ];
  let worst = 0, crashRoute = "";
  for (const [method, p] of routes) {
    for (const body of garbage) {
      const res = await hit(method, p, {
        headers: { ...as("st_editor"), "content-type": "application/json" },
        body,
      });
      if (res.status === 500) { worst = 500; crashRoute = `${method} ${p}`; }
      if (res._networkError) { worst = 999; crashRoute = `${method} ${p} (connection dropped)`; }
    }
  }
  ok("no route 500s or drops on garbage input", worst === 0, crashRoute);
}

/* ═══ 2. The URL-import SSRF fence holds under evasion ═══ */
section("URL-import SSRF fence resists evasion");
{
  const attempts = [
    "http://169.254.169.254/latest/meta-data/",       // AWS metadata
    "http://[::ffff:169.254.169.254]/",                // IPv4-mapped IPv6
    "http://127.0.0.1:8523/admin",                     // loopback to self
    "http://127.1/",                                    // shorthand loopback
    "http://0.0.0.0:8523/",                             // all-interfaces
    "http://localhost:8523/admin/users",               // named loopback
    "http://10.0.0.1/",                                 // private A
    "http://192.168.1.1/",                              // private C
    "http://172.16.0.1/",                               // private B
    "http://[fd00::1]/",                                // unique-local IPv6
    "file:///etc/passwd",                               // scheme escape
    "gopher://127.0.0.1:8523/",                         // scheme escape
    "ftp://internal/",                                  // scheme escape
    "http://foo@169.254.169.254/",                      // userinfo confusion
  ];
  let leaked = 0, crashed = 0;
  for (const url of attempts) {
    const res = await hit("POST", "/api/import/url", {
      headers: { ...as("st_editor"), "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (res.status === 500 || res._networkError) crashed++;
    // A success (created a space) would mean the fetch happened.
    if (res.status === 200) {
      const j = await res.json().catch(() => ({}));
      if (j.spaceSlug) leaked++;
    }
  }
  ok("every SSRF attempt is refused", leaked === 0, `${leaked} got through`);
  ok("no SSRF attempt crashes the route", crashed === 0, `${crashed} crashed`);
}

/* ═══ 3. Permission boundaries under forged ids ═══ */
section("Permission boundaries hold under forged and guessed ids");
{
  // A reader forging a PATCH to any page id — including nonexistent ones.
  const forgedIds = ["' OR '1'='1", "../../etc", "\x00null", "not-an-id", page.id];
  let wrote = 0;
  const before = db.prepare("SELECT title FROM pages WHERE id=?").get(page.id).title;
  for (const id of forgedIds) {
    await hit("PATCH", `/api/pages/${encodeURIComponent(id)}`, {
      headers: { ...as("st_reader"), "content-type": "application/json" },
      body: JSON.stringify({ title: "PWNED" }),
    });
  }
  const after = db.prepare("SELECT title FROM pages WHERE id=?").get(page.id).title;
  ok("a reader cannot rewrite a page by any id", after === before && before !== "PWNED");

  // An agent trying every mutating route it must never reach.
  const agentBlocked = [];
  for (const [m, p, body] of [
    ["POST", "/api/import/url", { url: "https://example.com/" }],
    ["POST", "/api/runs", { pageId: page.id, blockId: "x", connectorId: "y" }],
    ["POST", `/api/pages/${page.id}`, { title: "x" }],
  ]) {
    const res = await hit(m, p, { headers: { ...as("st_agent"), "content-type": "application/json" }, body: JSON.stringify(body) });
    agentBlocked.push(res.status === 403 || res.status === 401 || res.status === 405);
  }
  ok("an agent is refused every effectful route", agentBlocked.every(Boolean));

  // Deleting someone else's highlight by guessing ids.
  const mk = await hit("POST", "/api/highlights", {
    headers: { ...as("st_reader"), "content-type": "application/json" },
    body: JSON.stringify({ pageId: page.id, blockId: "bx", text: "reader private note" }),
  });
  const mine = await (await hit("GET", `/api/highlights?page=${page.id}`, { headers: as("st_reader") })).json();
  const hid = mine.highlights?.[0]?.id;
  if (hid) {
    await hit("DELETE", `/api/highlights?id=${hid}`, { headers: as("st_editor") });
    const still = await (await hit("GET", `/api/highlights?page=${page.id}`, { headers: as("st_reader") })).json();
    ok("one user cannot delete another's highlight", still.highlights?.length === 1);
    await hit("DELETE", `/api/highlights?id=${hid}`, { headers: as("st_reader") });
  } else {
    ok("highlight created for the boundary test", false, "setup failed");
  }
}

/* ═══ 4. Oversized and abusive reading beacons ═══ */
section("Reading beacons clamp abuse rather than trusting it");
{
  const rd = db.prepare("SELECT id FROM pages WHERE published=1 LIMIT 1").get();
  const blocks = db.prepare("SELECT content FROM pages WHERE id=?").get(rd.id);
  let firstBlockId = "b1";
  try { const bs = JSON.parse(blocks.content); firstBlockId = bs[0]?.id ?? "b1"; } catch { /* */ }

  // 100k entries, absurd dwell, negative revisits.
  const evil = {
    pageId: rd.id,
    blocks: Array.from({ length: 100000 }, () => ({
      id: firstBlockId, dwell: 1e15, revisits: -999, exit: true,
    })),
  };
  const before = db.prepare("SELECT COALESCE(SUM(dwell_ms),0) d, COALESCE(SUM(revisits),0) r FROM reading_signals WHERE page_id=?").get(rd.id);
  const res = await hit("POST", "/api/reading", {
    headers: { ...as("st_reader"), "content-type": "application/json" },
    body: JSON.stringify(evil),
  });
  ok("an oversized beacon does not 500", notServerError(res.status), `status ${res.status}`);
  const after = db.prepare("SELECT COALESCE(SUM(dwell_ms),0) d, COALESCE(SUM(revisits),0) r FROM reading_signals WHERE page_id=?").get(rd.id);
  // Per-visit dwell is capped at 120s; even if it counted, one visit can't add 1e15.
  ok("dwell is clamped, not trusted", after.d - before.d <= 120000, `added ${after.d - before.d}ms`);
  ok("revisits never go negative", after.r >= before.r, `delta ${after.r - before.r}`);
  db.prepare("DELETE FROM reading_signals WHERE page_id=?").run(rd.id);
}

/* ═══ 5. Concurrent writes to the same page ═══ */
section("Concurrent writes do not corrupt or deadlock");
{
  const target = db.prepare("SELECT id, space_id FROM pages WHERE published=1 LIMIT 1").get();
  // 30 editors saving the same page at once.
  const saves = Array.from({ length: 30 }, (_, i) =>
    hit("PATCH", `/api/pages/${target.id}`, {
      headers: { ...as("st_editor"), "content-type": "application/json" },
      body: JSON.stringify({ title: `concurrent ${i}` }),
    })
  );
  const results = await Promise.allSettled(saves);
  const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.status : 0));
  ok("no concurrent save 500s or drops", statuses.every((s) => notServerError(s) && s !== 0), `statuses ${[...new Set(statuses)].join(",")}`);
  // The database is still readable and consistent.
  const row = db.prepare("SELECT title FROM pages WHERE id=?").get(target.id);
  ok("the page still has exactly one coherent title", typeof row.title === "string" && /^concurrent \d+$/.test(row.title), row.title);
  const integrity = db.pragma("integrity_check", { simple: true });
  ok("the database integrity check passes after the storm", integrity === "ok", String(integrity));
}

/* ═══ 6. Composition engine on pathological documents ═══ */
section("The composition engine survives pathological pages");
{
  // Build a page whose blocks are hostile to the composer, publish it, read it.
  const sp = db.prepare("SELECT id, slug FROM spaces WHERE visibility='public' LIMIT 1").get();
  const now = Date.now();
  const nasty = [
    // self-referential embed
    { id: "n1", type: "syncedPage", props: { pageId: "brk_selfref", title: "self" }, content: [], children: [] },
    // variable that expands to another variable pattern (must not re-expand)
    { id: "n2", type: "paragraph", props: {}, content: [{ type: "text", text: "{{loop}}", styles: {} }], children: [] },
    // ifvar with no name
    { id: "n3", type: "ifvar", props: { name: "", equals: "" }, content: [{ type: "text", text: "orphan condition", styles: {} }], children: [] },
    // deeply nested children
    (() => { let b = { id: "leaf", type: "paragraph", props: {}, content: [{ type: "text", text: "deep", styles: {} }], children: [] };
             for (let i = 0; i < 200; i++) b = { id: "d" + i, type: "ifvar", props: { name: "x", equals: "" }, content: [], children: [b] };
             return b; })(),
  ];
  db.prepare("INSERT OR REPLACE INTO pages (id,space_id,parent_id,slug,title,content,content_text,position,published,cover,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("brk_selfref", sp.id, null, "brk-selfref", "Self ref", JSON.stringify(nasty), "", 998, 1, "", now, now);
  db.prepare("INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(`setting:vars:${sp.id}`, JSON.stringify({ loop: "{{loop}}", x: "" }));

  const res = await hit("GET", `/${sp.slug}/brk-selfref`, { headers: as("st_reader") });
  const text = await res.text();
  ok("a self-referential/nested page renders without 500", res.status === 200, `status ${res.status}`);
  ok("a recursive variable does not expand infinitely", !text.includes("{{loop}}{{loop}}"));

  db.prepare("DELETE FROM pages WHERE id='brk_selfref'").run();
  db.prepare("DELETE FROM kv WHERE key=?").run(`setting:vars:${sp.id}`);
}

/* ═══ 7. XSS: injected markup renders as text, not script ═══ */
section("Injected markup is inert in the reader");
{
  const sp = db.prepare("SELECT id, slug FROM spaces WHERE visibility='public' LIMIT 1").get();
  const now = Date.now();
  const payloads = [
    '<script>window.__pwned=1</script>',
    '<img src=x onerror="window.__pwned=1">',
    'javascript:alert(1)',
    '"><svg onload=alert(1)>',
  ];
  const blocks = payloads.map((p, i) => ({
    id: "x" + i, type: "paragraph", props: {},
    content: [{ type: "text", text: p, styles: {} }], children: [],
  }));
  // also a link whose href is javascript:
  blocks.push({ id: "xl", type: "paragraph", props: {}, content: [{ type: "link", href: "javascript:alert(1)", content: [{ type: "text", text: "click", styles: {} }] }], children: [] });
  db.prepare("INSERT OR REPLACE INTO pages (id,space_id,parent_id,slug,title,content,content_text,position,published,cover,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("brk_xss", sp.id, null, "brk-xss", "XSS probe", JSON.stringify(blocks), "", 997, 1, "", now, now);

  const html = await (await hit("GET", `/${sp.slug}/brk-xss`, { headers: as("st_reader") })).text();
  // A LIVE handler means an UNESCAPED tag: <img ... onerror=. The escaped
  // form (&lt;img ... onerror=&quot;) is inert text and matching it is a
  // false positive — verified in a browser that window.__pwned stays unset.
  ok("no live <script> executes the payload", !/<script>\s*window\.__pwned/i.test(html) && !/window\.__pwned=1<\/script>/i.test(html));
  ok("no live element carries an event handler", !/<[a-z]+[^>]*\son\w+\s*=/i.test(html));
  ok("no live javascript: href survives", !/<a[^>]+href=["']?javascript:/i.test(html));
  db.prepare("DELETE FROM pages WHERE id='brk_xss'").run();
}

/* ═══ 8. Rapid-fire load: a burst of reads stays healthy ═══ */
section("A burst of concurrent reads stays healthy");
{
  const targets = db.prepare("SELECT s.slug space, p.slug page FROM pages p JOIN spaces s ON s.id=p.space_id WHERE p.published=1 AND s.visibility='public' LIMIT 10").all();
  const t0 = Date.now();
  const burst = [];
  for (let i = 0; i < 200; i++) {
    const t = targets[i % targets.length];
    burst.push(hit("GET", `/${t.space}/${t.page}`));
  }
  const results = await Promise.allSettled(burst);
  const elapsed = Date.now() - t0;
  const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.status : 0));
  const good = statuses.filter((s) => s === 200).length;
  ok("200 concurrent reads all return 200", good === 200, `${good}/200 ok`);
  ok("the burst completes in reasonable time", elapsed < 30000, `${elapsed}ms`);
  console.log(`       (200 reads in ${elapsed}ms, ${Math.round(200000 / elapsed)} req/s)`);
}

/* ═══ cleanup ═══ */
for (const id of ["st_admin", "st_editor", "st_reader", "st_agent"]) {
  db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
  db.prepare("DELETE FROM space_members WHERE user_id=?").run(id);
  db.prepare("DELETE FROM highlights WHERE user_id=?").run(id);
  db.prepare("DELETE FROM users WHERE id=?").run(id);
}
// restore any title the concurrency test left behind
db.prepare("UPDATE pages SET title='Untitled' WHERE title LIKE 'concurrent %'").run();

console.log(`\n${"═".repeat(60)}`);
console.log(`${pass + fail} probes — ${pass} failed safely, ${fail} broke through`);
if (fails.length) {
  console.log("\nBROKE THROUGH:");
  for (const f of fails) console.log(`  ✗ ${f}`);
}
process.exit(fail ? 1 : 0);
