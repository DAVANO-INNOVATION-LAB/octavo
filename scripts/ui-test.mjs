// End-to-end UI test. Drives headless Chrome over the DevTools protocol and
// checks what a crawler cannot: runtime console errors, whether the editor
// actually opens a document, layout overflow at three viewports, and the
// interactions readers depend on.
//
// Usage: node scripts/ui-test.mjs [baseUrl]
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const BASE = process.argv[2] ?? "http://localhost:8523";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PROFILE = path.join(process.cwd(), ".uitest-profile");
const PORT = 9444;

const db = new Database(path.join(process.cwd(), "data", "octavo.db"));
const session = db
  .prepare("SELECT id FROM sessions ORDER BY expires_at DESC LIMIT 1")
  .get();
if (!session) {
  console.error("No session in the database — sign in once so authenticated pages can be tested.");
  process.exit(1);
}
const pick = (sql, ...a) => db.prepare(sql).get(...a);

const pubPage = pick(
  `SELECT s.slug AS space, p.slug AS page FROM pages p JOIN spaces s ON s.id=p.space_id
   WHERE p.published=1 AND s.visibility='public' AND s.slug='field-guide' LIMIT 1`
);
const cookbookPage = pick(
  `SELECT s.slug AS space, p.slug AS page FROM pages p JOIN spaces s ON s.id=p.space_id
   WHERE p.published=1 AND s.slug='ops-kubernetes' LIMIT 1`
);

// Pages chosen to cover every distinct rendering path, not just "some pages".
const ROUTES = [
  { path: "/", name: "library" },
  { path: "/graph", name: "knowledge graph (canvas)" },
  { path: `/${pubPage.space}`, name: "space cover" },
  { path: `/${pubPage.space}/${pubPage.page}`, name: "reader page" },
  { path: "/field-guide/block-library", name: "block library (callouts, math, drawio)" },
  { path: "/field-guide/3d-models", name: "3D models (canvas)" },
  { path: "/field-guide/diagrams", name: "mermaid diagrams" },
  { path: `/${cookbookPage.space}/${cookbookPage.page}`, name: "cookbook recipe" },
  { path: "/field-guide/print", name: "whole-book print view" },
  { path: "/whiteboard", name: "excalidraw whiteboard" },
  { path: "/field-guide/welcome/changes", name: "change requests" },
  { path: "/field-guide/welcome/changes/cr_demo1", name: "change request diff" },
  { path: "/login", name: "sign in" },
  { path: "/new", name: "new space" },
  { path: "/import", name: "import" },
  { path: "/account", name: "account" },
  { path: "/admin", name: "admin overview" },
  { path: "/admin/insights", name: "insights" },
  { path: "/admin/users", name: "users" },
  { path: "/admin/backups", name: "backups" },
  { path: "/admin/links", name: "broken links" },
  { path: "/admin/audit", name: "audit log" },
  { path: "/admin/notifications", name: "notification settings" },
  { path: "/inbox", name: "inbox" },
  { path: "/field-guide/sync", name: "markdown sync" },
  { path: "/guide-fr", name: "translation variant" },
  { path: "/petstore-api/get-pets", name: "API reference (interactive)" },
  { path: "/import/openapi", name: "OpenAPI import" },
  { path: "/ask", name: "ask the library" },
  { path: "/admin/ask", name: "ask settings" },
  { path: "/admin/connectors", name: "connectors" },
  { path: "/admin/sso", name: "single sign-on" },
  { path: `/${pubPage.space}/settings`, name: "space settings" },
  { path: `/${pubPage.space}/members`, name: "space members" },
];

// Editor pages: the failure mode that shipped last time.
const EDITOR_ROUTES = [
  { path: "/field-guide/block-library/edit", name: "editor: custom blocks" },
  { path: "/field-guide/3d-models/edit", name: "editor: 3D models" },
  { path: `/${pubPage.space}/${pubPage.page}/edit`, name: "editor: prose" },
  { path: `/${cookbookPage.space}/${cookbookPage.page}/edit`, name: "editor: code + tables" },
];

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

const failures = [];
const fail = (where, what) => failures.push({ where, what });
let checks = 0;

rmSync(PROFILE, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  "--disable-gpu",
  "--no-first-run",
  "--hide-scrollbars",
  "about:blank",
]);
chrome.stderr.on("data", () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function endpoint() {
  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch { /* not up */ }
    await sleep(250);
  }
  throw new Error("Chrome never exposed a debugging endpoint");
}

const ws = new WebSocket(await endpoint());
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
let consoleErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result ?? {});
    pending.delete(m.id);
    return;
  }
  // Runtime exceptions and console.error output — the signal a crawler misses.
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params?.exceptionDetails;
    consoleErrors.push(d?.exception?.description ?? d?.text ?? "exception");
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") {
    consoleErrors.push(
      (m.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200)
    );
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Page.enable", {}, sessionId);
await send("Runtime.enable", {}, sessionId);
await send("Network.enable", {}, sessionId);
// Authenticate as the signed-in user so admin and editor routes are reachable.
const host = new URL(BASE).hostname;
await send(
  "Network.setCookie",
  { name: "octavo_session", value: session.id, domain: host, path: "/" },
  sessionId
);

const evaluate = async (expression) => {
  const r = await send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId
  );
  return r?.result?.value;
};

async function visit(url, settle = 1200) {
  consoleErrors = [];
  await send("Page.navigate", { url: BASE + url }, sessionId);
  await sleep(settle);
}

/* ————— 1. every page: renders, no console errors ————— */
console.log("Pages — render and runtime errors\n");
for (const r of ROUTES) {
  const heavy = /graph|3d-models|whiteboard|diagrams|block-library|print/.test(r.path);
  await visit(r.path, heavy ? 3500 : 1200);
  checks++;
  const state = await evaluate(`(() => ({
    path: location.pathname,
    title: document.title,
    body: document.body.innerText.length,
    main: !!document.querySelector("main"),
    footer: document.body.innerText.includes("Davano Innovation Lab"),
    nextError: document.body.innerText.includes("Application error"),
  }))()`);
  const label = `${r.name} (${r.path})`;
  if (!state) { fail(label, "page did not evaluate"); continue; }
  if (state.nextError) fail(label, "client-side exception rendered");
  if (state.body < 40) fail(label, `almost no content (${state.body} chars)`);
  if (!state.footer) fail(label, "footer branding missing");
  const real = consoleErrors.filter(
    (e) => !/favicon|404 \(Not Found\).*favicon|Download the React DevTools/i.test(e)
  );
  if (real.length) fail(label, `console error: ${real[0].slice(0, 120)}`);
  process.stdout.write(
    `  ${real.length || state.nextError ? "✗" : "✓"} ${r.name}\n`
  );
}

/* ————— 2. the editor actually opens a document ————— */
console.log("\nEditor — opens the document (the regression that shipped once)\n");
for (const r of EDITOR_ROUTES) {
  await visit(r.path, 3800);
  checks++;
  const state = await evaluate(`(() => ({
    booted: !!document.querySelector(".bn-editor"),
    blocks: document.querySelectorAll(".bn-block-outer, .bn-block").length,
    schemaError: document.body.innerText.includes("Error creating document"),
  }))()`);
  const label = `${r.name} (${r.path})`;
  if (!state?.booted) fail(label, "editor did not boot");
  else if (state.schemaError) fail(label, "schema rejected the document");
  else if (!state.blocks) fail(label, "editor booted but rendered no blocks");
  const real = consoleErrors.filter((e) => !/favicon|DevTools/i.test(e));
  if (real.length) fail(label, `console error: ${real[0].slice(0, 120)}`);
  process.stdout.write(
    `  ${state?.booted && !state.schemaError ? "✓" : "✗"} ${r.name}${state?.blocks ? ` (${state.blocks} blocks)` : ""}\n`
  );
}

/* ————— 3. layout: no horizontal overflow at any viewport ————— */
console.log("\nLayout — horizontal overflow at three viewports\n");
for (const v of VIEWPORTS) {
  await send(
    "Emulation.setDeviceMetricsOverride",
    { width: v.width, height: v.height, deviceScaleFactor: 1, mobile: v.width < 768 },
    sessionId
  );
  const offenders = [];
  for (const r of ROUTES) {
    await visit(r.path, /graph|3d-models|whiteboard/.test(r.path) ? 2500 : 900);
    checks++;
    const over = await evaluate(
      `document.documentElement.scrollWidth - document.documentElement.clientWidth`
    );
    if (typeof over === "number" && over > 1) {
      offenders.push(`${r.path} +${over}px`);
      fail(`${r.name} @ ${v.name}`, `overflows by ${over}px`);
    }
  }
  console.log(
    `  ${offenders.length ? "✗" : "✓"} ${v.name} (${v.width}px)${offenders.length ? ` — ${offenders.slice(0, 3).join(", ")}` : ""}`
  );
}
await send(
  "Emulation.setDeviceMetricsOverride",
  { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  sessionId
);

/* ————— 4. interactions readers actually perform ————— */
console.log("\nInteractions\n");

await visit("/", 1200);
checks++;
const searchWorks = await evaluate(`(async () => {
  const res = await fetch("/api/search?q=deploy");
  const data = await res.json();
  return Array.isArray(data.results) && data.results.length > 0;
})()`);
if (!searchWorks) fail("search", "no results for a term known to exist");
console.log(`  ${searchWorks ? "✓" : "✗"} search returns results`);

checks++;
// Toggle against whatever the page currently is. Asserting that "dark"
// changes the background assumes the page started light, which is false
// whenever the browser reports a dark system preference.
const themeWorks = await evaluate(`(async () => {
  const read = () => getComputedStyle(document.body).backgroundColor;
  const before = read();
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.setAttribute("data-theme", dark ? "light" : "dark");
  await new Promise(r => setTimeout(r, 250));
  const after = read();
  document.documentElement.removeAttribute("data-theme");
  return before !== after;
})()`);
if (!themeWorks) fail("theme", "dark mode did not change the background");
console.log(`  ${themeWorks ? "✓" : "✗"} dark mode repaints`);

await visit("/graph", 9000);
checks++;
const graphWorks = await evaluate(`(() => {
  const c = document.querySelector("canvas");
  if (!c) return { ok: false, why: "no canvas" };
  const ctx = c.getContext("2d");
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  let drawn = 0;
  for (let i = 3; i < px.length; i += 4000) if (px[i] > 0) drawn++;
  const settled = document.body.innerText.includes("click a page to open it");
  return { ok: drawn > 0 && settled, drawn, settled };
})()`);
if (!graphWorks?.ok)
  fail("graph", `canvas empty or never settled (${JSON.stringify(graphWorks)})`);
console.log(`  ${graphWorks?.ok ? "✓" : "✗"} graph draws and settles`);

await visit("/field-guide/block-library", 3000);
checks++;
const blocksRender = await evaluate(`(() => ({
  callout: !!document.querySelector(".blk-callout"),
  details: !!document.querySelector(".blk-details"),
  steps: !!document.querySelector(".blk-steps"),
  math: !!document.querySelector(".katex"),
  note: !!document.querySelector(".margin-note-anchor"),
  code: !!document.querySelector(".codeblock"),
}))()`);
const missing = Object.entries(blocksRender ?? {}).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) fail("block library", `not rendered: ${missing.join(", ")}`);
console.log(`  ${missing.length ? "✗" : "✓"} docs blocks render (${Object.keys(blocksRender ?? {}).length - missing.length}/6)`);

checks++;
const noteOpens = await evaluate(`(async () => {
  const a = document.querySelector(".margin-note-anchor");
  if (!a) return false;
  a.click();
  await new Promise(r => setTimeout(r, 300));
  return !!document.querySelector(".margin-note-body");
})()`);
if (!noteOpens) fail("margin note", "did not open on click");
console.log(`  ${noteOpens ? "✓" : "✗"} margin note opens`);

await visit("/field-guide/3d-models", 3500);
checks++;
const modelsDraw = await evaluate(`(() => {
  const canvases = [...document.querySelectorAll(".blk-model canvas")];
  if (!canvases.length) return { ok: false, why: "no model canvas" };
  const painted = canvases.filter(c => {
    const px = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < px.length; i += 4000) if (px[i] > 0) return true;
    return false;
  });
  return { ok: painted.length === canvases.length, painted: painted.length, total: canvases.length };
})()`);
if (!modelsDraw?.ok) fail("3D models", `only ${modelsDraw?.painted}/${modelsDraw?.total} drew`);
console.log(`  ${modelsDraw?.ok ? "✓" : "✗"} 3D models draw (${modelsDraw?.painted}/${modelsDraw?.total})`);

await visit("/admin/insights", 1500);
checks++;
const insightsWork = await evaluate(
  `document.body.innerText.toLowerCase().includes("most read") && document.body.innerText.toLowerCase().includes("top searches")`
);
if (!insightsWork) fail("insights", "sections missing");
console.log(`  ${insightsWork ? "✓" : "✗"} insights render`);

/* ————— accessibility: audited every release, as checks, not intentions ————— */
console.log("\nAccessibility\n");
{
  const A11Y_ROUTES = ["/", "/login", "/field-guide", "/field-guide/welcome", "/graph", "/ask"];
  for (const route of A11Y_ROUTES) {
    await visit(route, 1500);
    checks++;
    const audit = await evaluate(`(() => {
      const problems = [];
      // Every image carries alt text (empty alt is a decision, absent is not).
      for (const img of document.querySelectorAll("img"))
        if (!img.hasAttribute("alt")) problems.push("img without alt: " + (img.src || "").slice(-40));
      // Every form control is labelled one way or another.
      for (const el of document.querySelectorAll("input:not([type=hidden]), select, textarea")) {
        const labelled = el.labels?.length > 0 ||
          el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ||
          el.hasAttribute("placeholder") || el.hasAttribute("title");
        if (!labelled) problems.push("unlabelled " + el.tagName.toLowerCase() + " name=" + (el.name || "?"));
      }
      // One h1, and heading levels never skip downward.
      const h1s = document.querySelectorAll("h1").length;
      if (h1s > 1) problems.push(h1s + " h1 elements");
      let prev = 0;
      for (const h of document.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
        const level = Number(h.tagName[1]);
        if (prev && level > prev + 1) problems.push("heading skips h" + prev + " to h" + level);
        prev = level;
      }
      // Buttons and links say something.
      for (const b of document.querySelectorAll("button, a"))
        if (!b.textContent.trim() && !b.getAttribute("aria-label") && !b.getAttribute("title") && b.querySelector("svg"))
          problems.push("icon-only " + b.tagName.toLowerCase() + " without a label");
      return problems.slice(0, 5);
    })()`);
    const bad = Array.isArray(audit) ? audit : ["audit did not run"];
    if (bad.length) fail(`a11y ${route}`, bad.join(" · "));
    console.log(`  ${bad.length ? "✗" : "✓"} ${route}`);
  }
}

/* ————— reading signals: a real read produces a real signal ————— */
//
// The only check that proves the observer end to end. Scoring is unit-tested
// and the endpoint is integration-tested; neither covers whether a browser
// scrolling a page turns into rows.
//
// Scrolling is driven with real wheel events rather than scrollIntoView.
// A headless page with no window does not move for programmatic scrolling,
// which makes a scrollIntoView-based test pass by never exercising anything.
{
  const target = db
    .prepare(
      `SELECT p.id, p.slug, s.slug AS space
         FROM pages p JOIN spaces s ON s.id = p.space_id
        WHERE p.published = 1 AND s.visibility = 'public'
          AND length(p.content) > 6000
        LIMIT 1`
    )
    .get();

  if (target) {
    db.prepare("DELETE FROM reading_signals WHERE page_id = ?").run(target.id);
    await send(
      "Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false },
      sessionId
    );
    await visit(`/${target.space}/${target.slug}`, 2000);

    const wheel = async (dy) => {
      await send(
        "Input.dispatchMouseEvent",
        { type: "mouseWheel", x: 640, y: 360, deltaX: 0, deltaY: dy, pointerType: "mouse" },
        sessionId
      );
      await sleep(260);
    };
    const scrollTop = () =>
      evaluate("document.scrollingElement.scrollTop");

    // Read down, come back up twice, then settle further down.
    for (let i = 0; i < 8; i++) await wheel(400);
    const midway = await scrollTop();
    for (let i = 0; i < 6; i++) await wheel(-400);   // back up — re-read
    await sleep(700);
    for (let i = 0; i < 6; i++) await wheel(400);
    await sleep(500);
    for (let i = 0; i < 6; i++) await wheel(-400);   // back up again
    await sleep(700);
    for (let i = 0; i < 10; i++) await wheel(400);
    await sleep(800);

    // Leaving the page is what sends the beacon.
    await visit("/graph", 2200);
    await sleep(900);

    const rows = db
      .prepare(
        "SELECT block_id, views, dwell_ms, revisits, exits FROM reading_signals WHERE page_id = ?"
      )
      .all(target.id);
    const revisited = rows.filter((r) => r.revisits > 0);
    const dwelt = rows.filter((r) => r.dwell_ms > 0);
    const exited = rows.filter((r) => r.exits > 0);

    checks++;
    const scrolled = Number(midway) > 0;
    if (!scrolled) fail("reading signals", "the page never scrolled, so nothing was exercised");
    else if (rows.length === 0) fail("reading signals", "a full read produced no rows");
    else if (dwelt.length === 0) fail("reading signals", "no passage recorded any time on screen");
    else if (revisited.length === 0)
      fail("reading signals", "scrolling back up recorded no revisits — the strongest signal is dead");
    else if (exited.length !== 1)
      fail("reading signals", `expected exactly one exit passage, got ${exited.length}`);
    const good = scrolled && rows.length > 0 && dwelt.length > 0 && revisited.length > 0;
    console.log(
      `  ${good ? "✓" : "✗"} reading signals (${rows.length} passages, ` +
        `${revisited.length} re-read, ${exited.length} exit)`
    );

    checks++;
    const columns = Object.keys(rows[0] ?? {});
    const identifying = columns.filter((c) => /user|session|ip|actor|visitor/i.test(c));
    if (identifying.length)
      fail("reading signals", `identity column present: ${identifying.join(", ")}`);
    console.log(`  ${identifying.length ? "✗" : "✓"} no column identifies a reader`);
  }
}

ws.close();
chrome.kill();
await sleep(400);
try { rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* gitignored */ }

console.log(`\n${"=".repeat(64)}`);
console.log(`${checks} checks run`);
if (!failures.length) {
  console.log("PASS — no defects found.");
  process.exit(0);
}
console.log(`FAIL — ${failures.length} defect(s):\n`);
for (const f of failures) console.log(`  ${f.where}\n      ${f.what}`);
process.exit(1);
