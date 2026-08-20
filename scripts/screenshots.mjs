// Capture UI screenshots by driving headless Chrome over the DevTools
// protocol. The --screenshot flag hangs on pages that never go network-idle
// (canvas animation, KaTeX, Mermaid); CDP lets us wait for our own signal
// and then shoot. Usage: node scripts/screenshots.mjs [baseUrl]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

const BASE = process.argv[2] ?? "http://localhost:8523";
const CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PROFILE = path.join(process.cwd(), ".shot-profile");
const OUT = path.join(process.cwd(), "docs", "screenshots");
const PORT = 9333;

const SHOTS = [
  { name: "library", url: "/", w: 1440, h: 900, settle: 1200 },
  { name: "reader", url: "/field-guide/welcome", w: 1440, h: 1000, settle: 1500 },
  { name: "block-library", url: "/field-guide/block-library", w: 1440, h: 1100, settle: 2500 },
  { name: "cookbook", url: "/ops-kubernetes/deploy-api-gateway-with-zero-downtime", w: 1440, h: 1000, settle: 1500 },
  { name: "graph", url: "/graph", w: 1440, h: 900, settle: 9000 },
  { name: "diagrams", url: "/field-guide/diagrams", w: 1440, h: 1000, settle: 3000 },
];

mkdirSync(OUT, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  "--disable-gpu",
  "--no-first-run",
  "--hide-scrollbars",
  "--force-device-scale-factor=2",
  "--window-size=1440,1000",
  "about:blank",
]);
chrome.stderr.on("data", () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function endpoint() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await res.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("Chrome did not expose a debugging endpoint");
}

const ws = new WebSocket(await endpoint());
await new Promise((r) => (ws.onopen = r));

let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result ?? {});
    pending.delete(msg.id);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", {
  targetId,
  flatten: true,
});
await send("Page.enable", {}, sessionId);

for (const shot of SHOTS) {
  await send(
    "Emulation.setDeviceMetricsOverride",
    { width: shot.w, height: shot.h, deviceScaleFactor: 2, mobile: false },
    sessionId
  );
  await send("Page.navigate", { url: BASE + shot.url }, sessionId);
  // Fixed settle beats network-idle here: canvas and font work continue
  // well past the last request.
  await sleep(shot.settle);
  const { data } = await send(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: false },
    sessionId
  );
  if (!data) {
    console.log(`✗ ${shot.name}`);
    continue;
  }
  const file = path.join(OUT, `${shot.name}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`✓ ${shot.name}.png`);
}

ws.close();
chrome.kill();
// Chrome writes to the profile as it exits; give it a moment, and never let
// cleanup failure mask a successful capture run.
await sleep(500);
try {
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
  /* leftover profile is harmless — it is gitignored */
}
console.log(`\nsaved to docs/screenshots/`);
