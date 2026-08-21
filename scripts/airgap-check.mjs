// Prove the app works with no route to the internet.
//
// Boots headless Chrome, intercepts every request, and fails any that leaves
// localhost — exactly what a disconnected network does — then walks the routes
// that pull the heaviest third-party machinery (Excalidraw fonts, KaTeX fonts,
// Mermaid, Shiki, the editor bundle) and reports anything that tried to escape.
//
// A clean run means an operator can load this image onto an isolated network
// and every page still renders.
//
// Usage: node scripts/airgap-check.mjs [baseUrl]
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const BASE = process.argv[2] ?? "http://localhost:8523";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PROFILE = path.join(process.cwd(), ".airgap-profile");
const PORT = 9445;

// Hosts that are inside the deployment. Everything else is "the internet".
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const INERT = /^(data|blob|about|chrome|devtools):/;

const db = new Database(path.join(process.cwd(), "data", "octavo.db"));
const session = db
  .prepare("SELECT id FROM sessions ORDER BY expires_at DESC LIMIT 1")
  .get();
if (!session) {
  console.error("No session in the database — sign in once so editor routes are reachable.");
  process.exit(1);
}
const pick = (sql, ...a) => db.prepare(sql).get(...a);
const anyPage = pick(
  `SELECT s.slug AS space, p.slug AS page, p.id AS id
   FROM pages p JOIN spaces s ON s.id = p.space_id
   WHERE p.published = 1 LIMIT 1`
);

// Routes chosen because each one loads a different third-party asset family.
const ROUTES = [
  ["/", "library"],
  ["/whiteboard", "Excalidraw (fonts were the CDN risk)"],
  ["/whiteboard/drawio", "draw.io embed"],
  ["/field-guide/block-library", "KaTeX math, callouts, draw.io block"],
  ["/field-guide/diagrams", "Mermaid"],
  ["/field-guide/3d-models", "WebGL model blocks"],
  ["/field-guide/print", "whole-book print view"],
  ["/graph", "knowledge graph"],
  [`/${anyPage.space}/${anyPage.page}`, "reader page (Shiki)"],
  [`/${anyPage.space}/${anyPage.page}/edit`, "editor bundle (BlockNote)"],
  ["/login", "sign in"],
  ["/admin", "admin"],
  ["/admin/audit", "audit log"],
  ["/inbox", "inbox"],
  ["/field-guide/sync", "markdown sync"],
  ["/guide-fr", "translation variant"],
  ["/petstore-api/get-pets", "API reference"],
  ["/ask", "ask the library"],
];

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
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("Chrome never exposed a debugging endpoint");
}

const ws = new WebSocket(await endpoint());
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();

let route = "(startup)";
/** Local assets that failed to load — the app failing, not the air gap. */
let localFailures = [];
/** host -> { count, routes:Set, samples:Set } */
const escaped = new Map();
let consoleErrors = [];

const send = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

let sessionId;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result ?? {});
    pending.delete(m.id);
    return;
  }

  if (m.method === "Fetch.requestPaused") {
    const { requestId, request } = m.params;
    const url = request.url;
    let external = false;
    if (!INERT.test(url)) {
      try {
        external = !LOCAL.has(new URL(url).hostname);
      } catch {
        external = false;
      }
    }
    if (external) {
      const host = new URL(url).hostname;
      if (!escaped.has(host))
        escaped.set(host, { count: 0, routes: new Set(), samples: new Set() });
      const rec = escaped.get(host);
      rec.count++;
      rec.routes.add(route);
      if (rec.samples.size < 3) rec.samples.add(url.slice(0, 120));
      // Behave like a severed network rather than a polite refusal.
      send("Fetch.failRequest", { requestId, errorReason: "InternetDisconnected" }, sessionId);
    } else {
      send("Fetch.continueRequest", { requestId }, sessionId);
    }
    return;
  }

  if (m.method === "Network.responseReceived") {
    const u = m.params.response?.url ?? "";
    const status = m.params.response?.status ?? 0;
    if (status >= 400) {
      let local = false;
      try {
        local = LOCAL.has(new URL(u).hostname);
      } catch { /* not a resolvable URL */ }
      // A 404 on a page route is the app answering; a 404 on an asset the
      // page asked for means the build did not ship something it references.
      const isAsset = /\/_next\/|\.(js|css|woff2?|ttf|png|svg|json|wasm)(\?|$)/.test(u);
      if (local && isAsset) localFailures.push(`HTTP ${status} ${u.slice(0, 90)}`);
    }
  }

  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params?.exceptionDetails;
    consoleErrors.push(d?.exception?.description ?? d?.text ?? "exception");
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") {
    consoleErrors.push(
      (m.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 180)
    );
  }
};

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
({ sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }));
await send("Page.enable", {}, sessionId);
await send("Runtime.enable", {}, sessionId);
await send("Network.enable", {}, sessionId);
await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
await send(
  "Network.setCookie",
  { name: "octavo_session", value: session.id, domain: new URL(BASE).hostname, path: "/" },
  sessionId
);

const evaluate = async (expression) => {
  const r = await send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId
  );
  return r?.result?.value;
};

console.log(`Air-gap check against ${BASE}`);
console.log("Every request off localhost is failed as InternetDisconnected.\n");

const broken = [];
for (const [p, why] of ROUTES) {
  route = p;
  consoleErrors = [];
  localFailures = [];
  await send("Page.navigate", { url: `${BASE}${p}` }, sessionId);
  // Fonts and canvases load late; give lazy work time to attempt a fetch.
  await sleep(2600);
  const body = (await evaluate("document.body?.innerText?.length ?? 0")) ?? 0;
  const title = await evaluate("document.title");
  // An iframe pointing off-network is a failure even when nothing fetched it
  // during the sample window — it would spin forever on a real air gap.
  const offNet = (await evaluate(
    `JSON.stringify([...document.querySelectorAll("iframe,img,script,link")]
       .map(e => e.src || e.href || "")
       .filter(u => /^https?:\\/\\//.test(u) && !/^https?:\\/\\/(localhost|127\\.0\\.0\\.1)/.test(u)))`
  )) ?? "[]";
  const offNetList = JSON.parse(offNet);
  // Ignore the console noise that *is* the air gap doing its job.
  const real = consoleErrors.filter(
    (e) => !/InternetDisconnected|ERR_INTERNET|Failed to fetch|net::ERR/i.test(e)
  );
  const ok =
    body > 40 &&
    real.length === 0 &&
    offNetList.length === 0 &&
    localFailures.length === 0;
  if (!ok) broken.push({ p, why, body, errors: real.slice(0, 2), offNetList });
  const mark = ok ? "ok  " : "FAIL";
  console.log(`  ${mark} ${p.padEnd(34)} ${why}`);
  if (!ok) {
    if (body <= 40) console.log(`         page rendered ${body} chars (title: ${title})`);
    offNetList.forEach((u) => console.log(`         off-network element: ${u.slice(0, 110)}`));
    [...new Set(localFailures)]
      .slice(0, 3)
      .forEach((f) => console.log(`         local asset failed: ${f}`));
    real.slice(0, 2).forEach((e) => console.log(`         ${e}`));
  }
}

console.log("\n—— requests that tried to leave the network ——");
if (escaped.size === 0) {
  console.log("  none. Every asset resolved locally.");
} else {
  for (const [host, rec] of [...escaped].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${host}  (${rec.count}x, on ${[...rec.routes].join(", ")})`);
    for (const s of rec.samples) console.log(`      ${s}`);
  }
}

await send("Target.closeTarget", { targetId });
chrome.kill();
// Chrome unlinks profile files as it exits; racing it throws ENOTEMPTY.
await sleep(600);
try {
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
  /* a leftover profile dir is harmless — it is recreated next run */
}

const hardFail = broken.length > 0;
console.log(
  `\n${ROUTES.length - broken.length}/${ROUTES.length} routes render with no network.`
);
if (escaped.size > 0) {
  console.log(
    "Note: hosts listed above are reachable-by-design only if the operator allows them."
  );
}
process.exit(hardFail ? 1 : 0);
