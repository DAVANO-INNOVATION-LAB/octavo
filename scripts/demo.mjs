// A demo instance nothing else can break.
//
// Today's lesson, learned the hard way: the dev/test server on 8523 gets
// killed, rebuilt, and reseeded constantly — integration fixtures appear in
// it, pages get retitled by test probes, and its static assets are swapped
// mid-request. Demoing against it is demoing against a moving target.
//
// This runs the app on ITS OWN PORT (8600) against ITS OWN COPY of the data,
// staged from a build snapshot taken now. Test suites point at 8523/8541 and
// never touch it; rebuilding .next does not touch it, because the whole
// standalone tree is copied out first. The demo copy also drops the spaces
// nobody wants an audience reading over your shoulder: test scratch and
// internal working notes.
//
// Usage:
//   node scripts/demo.mjs          # stage + start
//   node scripts/demo.mjs stop
import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import path from "node:path";
import Database from "better-sqlite3";

const ROOT = process.cwd();
const STAGE = path.join(ROOT, ".demo");
const PORT = 8600;
const PIDFILE = path.join(STAGE, "demo.pid");

// Spaces that make a demo worse: scratch, probes, and internal notes.
const DROP_SLUGS = new Set([
  "test",
  "test-network",
  "test-zg91",
  "dev",
  "comparison",
  "competitive-assessment",
  "technical-review-memo",
]);

function stop() {
  try {
    const pid = Number(readFileSync(PIDFILE, "utf8"));
    process.kill(pid);
    console.log(`stopped demo (pid ${pid})`);
  } catch {
    console.log("no demo running");
  }
  try {
    execSync(`lsof -ti :${PORT} | xargs kill -9`, { stdio: "ignore" });
  } catch {
    /* nothing on the port */
  }
}

if (process.argv[2] === "stop") {
  stop();
  process.exit(0);
}

stop();

if (!existsSync(path.join(ROOT, ".next/standalone/server.js"))) {
  console.error("No build found — run `npm run build` once first.");
  process.exit(1);
}

console.log("staging a frozen copy of the build and data…");
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
cpSync(path.join(ROOT, ".next/standalone"), path.join(STAGE, "app"), { recursive: true });
cpSync(path.join(ROOT, ".next/static"), path.join(STAGE, "app/.next/static"), { recursive: true });
cpSync(path.join(ROOT, "public"), path.join(STAGE, "app/public"), { recursive: true });
mkdirSync(path.join(STAGE, "data"), { recursive: true });

// A consistent copy of the live database, then pruned for an audience.
const src = new Database(path.join(ROOT, "data", "octavo.db"), { readonly: true });
await src.backup(path.join(STAGE, "data", "octavo.db"));
src.close();
if (existsSync(path.join(ROOT, "data", "uploads"))) {
  cpSync(path.join(ROOT, "data", "uploads"), path.join(STAGE, "data", "uploads"), {
    recursive: true,
  });
}

const db = new Database(path.join(STAGE, "data", "octavo.db"));
db.pragma("foreign_keys = ON");
const dropped = [];
for (const s of db.prepare("SELECT id, slug, name FROM spaces").all()) {
  if (DROP_SLUGS.has(s.slug)) {
    db.prepare("DELETE FROM spaces WHERE id = ?").run(s.id);
    dropped.push(s.slug);
  }
}
// Sessions belong to the source instance; a demo starts signed out.
db.prepare("DELETE FROM sessions").run();
db.close();
if (dropped.length) console.log(`dropped from the demo copy: ${dropped.join(", ")}`);

const child = spawn("node", [path.join(STAGE, "app", "server.js")], {
  env: {
    ...process.env,
    PORT: String(PORT),
    OCTAVO_DATA_DIR: path.join(STAGE, "data"),
    NODE_ENV: "production",
  },
  detached: true,
  stdio: ["ignore", "ignore", "ignore"],
});
child.unref();
writeFileSync(PIDFILE, String(child.pid));

// Wait until it answers.
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://localhost:${PORT}/login`);
    if (r.ok) break;
  } catch {
    /* booting */
  }
  await new Promise((r) => setTimeout(r, 500));
}

console.log(`
demo is up:  http://localhost:${PORT}
  frozen from this moment — rebuilds, test suites, and other sessions
  cannot reach it. Stop with: npm run demo:stop
`);
