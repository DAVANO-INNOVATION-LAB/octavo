// Prove the failover lease refuses to produce two writers, and that a restore
// drill fails on a backup that is not a library.
//
// This is the one mechanism in the codebase where a bug is unrecoverable:
// two nodes writing one SQLite file corrupts it, quietly, and the corruption
// arrives long after the mistake. So the interesting cases here are all the
// ones where promotion must NOT happen.
//
// Usage: node scripts/failover-test.mjs
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

const STAGE = path.join(process.cwd(), ".fail-stage");
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(path.join(STAGE, "data"), { recursive: true });

/* ---- the shared store both nodes see ---- */
const store = new Map();
const stub = createServer((req, res) => {
  if (req.method === "PUT") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { store.set(req.url, Buffer.concat(chunks)); res.writeHead(200).end(); });
    return;
  }
  const body = store.get(req.url);
  if (!body) return res.writeHead(404).end();
  res.writeHead(200, { "content-length": body.length }).end(body);
});
await new Promise((r) => stub.listen(9096, r));
const TARGET = {
  endpoint: "http://127.0.0.1:9096", region: "us-east-1", bucket: "b",
  accessKey: "k", secretKey: "s", prefix: "octavo", intervalMinutes: 1, keepDays: 1,
};

/* ---- stage failover.ts with its world replaced ---- */
function stageFailover({ replica, nodeId }) {
  const src = readFileSync("src/lib/failover.ts", "utf8")
    .replace(/import "server-only";\n?/, "")
    .replace(/import \{ now \} from "\.\/util";\n?/, "const now = () => Date.now();\n")
    .replace(/import \{ isReplica \} from "\.\/db";\n?/, `const isReplica = () => ${replica};\n`)
    .replace(
      /import \{ replicaTarget, sigv4Fetch, type ReplicaTarget \} from "\.\/replicate";\n?/,
      `const replicaTarget = () => globalThis.__target;
const sigv4Fetch = async (t, method, key, body) => {
  const url = t.endpoint + "/" + t.bucket + "/" + key;
  return fetch(url, { method, body: method === "PUT" ? new Uint8Array(body) : undefined });
};\n`
    );
  const file = path.join(STAGE, `failover-${nodeId}.ts`);
  writeFileSync(file, src);
  return file;
}

globalThis.__target = TARGET;
const LEASE = "/b/octavo/lease.json";

console.log("\nThe lease refuses to make two writers\n");
{
  process.env.OCTAVO_NODE_ID = "standby-a";
  process.env.OCTAVO_LEASE_STALE_SECONDS = "60";
  const a = await import(pathToFileURL(stageFailover({ replica: true, nodeId: "a" })));

  // 1. No lease at all: a system that has never shipped is not a failover.
  store.delete(LEASE);
  let s = await a.checkFailover();
  ok("never having shipped is not grounds for promotion", !s.promotable && /no lease/.test(s.reason), JSON.stringify(s));

  // 2. A fresh lease: the primary is alive and nobody else is the primary.
  store.set(LEASE, Buffer.from(JSON.stringify({ holder: "primary-1", renewed: Date.now() })));
  s = await a.checkFailover();
  ok("a freshly renewed lease blocks promotion", !s.promotable && /renewed/.test(s.reason), JSON.stringify(s));

  // 3. A lease renewed just inside the window still blocks. A slow ship on a
  //    big library must not read as an outage.
  store.set(LEASE, Buffer.from(JSON.stringify({ holder: "primary-1", renewed: Date.now() - 55_000 })));
  s = await a.checkFailover();
  ok("a lease inside the staleness window still blocks", !s.promotable, JSON.stringify(s));

  // 4. Genuinely stale: this standby may take it.
  store.set(LEASE, Buffer.from(JSON.stringify({ holder: "primary-1", renewed: Date.now() - 600_000 })));
  s = await a.checkFailover();
  ok("a lapsed lease makes exactly this node promotable", s.promotable, JSON.stringify(s));
  ok("taking the lease records this node as the holder",
    JSON.parse(store.get(LEASE).toString()).holder === "standby-a",
    store.get(LEASE)?.toString());

  // 5. A second standby now looks: the lease is fresh (A just took it), so B
  //    must stand down. This is the split-brain case, and the whole point.
  process.env.OCTAVO_NODE_ID = "standby-b";
  const b = await import(pathToFileURL(stageFailover({ replica: true, nodeId: "b" })));
  const sb = await b.checkFailover();
  ok("a second standby does not also promote", !sb.promotable, JSON.stringify(sb));

  // 6. A node that already holds a lapsed lease stays promotable across
  //    restarts rather than flapping.
  process.env.OCTAVO_NODE_ID = "standby-a";
  const a2 = await import(pathToFileURL(stageFailover({ replica: true, nodeId: "a2" })));
  store.set(LEASE, Buffer.from(JSON.stringify({ holder: "standby-a", renewed: Date.now() - 600_000 })));
  const s2 = await a2.checkFailover();
  ok("the holder of a lapsed lease stays promotable", s2.promotable, JSON.stringify(s2));

  // 7. The primary never promotes itself, whatever the lease says.
  const p = await import(pathToFileURL(stageFailover({ replica: false, nodeId: "p" })));
  const sp = await p.checkFailover();
  ok("a primary is never promotable", !sp.promotable && /primary/.test(sp.reason), JSON.stringify(sp));

  // 8. With no shared store there is no arbiter, so nobody may promote.
  globalThis.__target = null;
  const s3 = await a2.checkFailover();
  ok("with no shared store, nobody promotes", !s3.promotable, JSON.stringify(s3));
  globalThis.__target = TARGET;
}

console.log("\nThe restore drill\n");
{
  const dataDir = path.join(STAGE, "data");
  const src = readFileSync("src/lib/restore-drill.ts", "utf8")
    .replace(/import "server-only";\n?/, "")
    .replace(/import \{ DATA_DIR \} from "\.\/db";\n?/, `const DATA_DIR = ${JSON.stringify(dataDir)};\n`)
    .replace(/import \{ now \} from "\.\/util";\n?/, "const now = () => Date.now();\n")
    .replace(
      /import \{ replicaTarget, sigv4Fetch \} from "\.\/replicate";\n?/,
      `const replicaTarget = () => globalThis.__target;
const sigv4Fetch = async (t, method, key) => fetch(t.endpoint + "/" + t.bucket + "/" + key, { method });\n`
    );
  const file = path.join(STAGE, "restore-drill.ts");
  writeFileSync(file, src);
  const drill = await import(pathToFileURL(file));
  const SNAP = "/b/octavo/octavo-latest.db";

  // A real, populated snapshot.
  const good = path.join(STAGE, "good.db");
  const gdb = new Database(good);
  gdb.exec("CREATE TABLE spaces (id TEXT); CREATE TABLE pages (id TEXT, content TEXT);");
  gdb.prepare("INSERT INTO spaces VALUES ('s1')").run();
  for (let i = 0; i < 10; i++) gdb.prepare("INSERT INTO pages VALUES (?, 'x')").run(`p${i}`);
  gdb.close();
  store.set(SNAP, readFileSync(good));

  let r = await drill.runRestoreDrill(10);
  ok("a good snapshot restores and reports what it holds", r.ok && r.pages === 10 && r.spaces === 1, JSON.stringify(r));
  ok("the drill is recorded so someone can see it later", drill.lastDrill()?.ok === true);

  // An empty-but-valid database: opens, passes integrity, holds no library.
  const empty = path.join(STAGE, "empty.db");
  const edb = new Database(empty);
  edb.exec("CREATE TABLE spaces (id TEXT); CREATE TABLE pages (id TEXT, content TEXT);");
  edb.close();
  store.set(SNAP, readFileSync(empty));
  r = await drill.runRestoreDrill(10);
  ok("an empty snapshot is a failed drill, not a passed one", !r.ok && /no library/.test(r.error), JSON.stringify(r));

  // A snapshot that shrank: it restores perfectly and is still a disaster.
  store.set(SNAP, readFileSync(good));
  r = await drill.runRestoreDrill(100);
  ok("a snapshot far smaller than the live library fails", !r.ok && /%/.test(r.error), JSON.stringify(r));

  // Corruption.
  store.set(SNAP, Buffer.from("this is not a database at all"));
  r = await drill.runRestoreDrill(10);
  ok("a corrupt snapshot fails the drill", !r.ok, JSON.stringify(r));

  // Nothing shipped yet.
  store.delete(SNAP);
  r = await drill.runRestoreDrill(10);
  ok("a missing snapshot fails loudly", !r.ok && /404|fetch/.test(r.error), JSON.stringify(r));

  ok("every attempt is kept in the history", drill.drillHistory().length >= 5, String(drill.drillHistory().length));
}

stub.close();
rmSync(STAGE, { recursive: true, force: true });
console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
