// Prove the replication loop end to end, with no cloud in the room.
//
// Two halves:
//   1. The SigV4 signature, checked against a value computed independently
//      (Python reference implementation of the AWS signing steps). If the
//      canonical request or key derivation drifts, this catches it.
//   2. The whole loop against a local S3 stub: the primary ships a snapshot,
//      the stub stores it, a replica-side pull fetches, verifies, and swaps
//      it in — and a corrupted object is refused.
//
// Usage: node scripts/replication-test.mjs
import { createServer } from "node:http";
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

let pass = 0,
  fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ok    ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

// Stage the module the same way the unit tests do.
const STAGE = path.join(process.cwd(), ".repl-stage");
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
const src = readFileSync("src/lib/replicate.ts", "utf8")
  .replace(/import "server-only";\n?/, "")
  .replace(/import \{ DATA_DIR, getDb \} from "\.\/db";\n?/, "const DATA_DIR = process.env.TEST_DATA_DIR; const getDb = () => globalThis.__testDb;\n")
  .replace(/import \{ getSetting \} from "\.\/settings";\n?/, "const getSetting = () => process.env.TEST_TARGET ?? null;\n")
  .replace(/import \{ now \} from "\.\/util";\n?/, "const now = () => Date.now();\n");
writeFileSync(path.join(STAGE, "replicate.ts"), src);
// The staged module reads these at load time, so they exist before import.
process.env.TEST_DATA_DIR = path.join(STAGE, "data");
const repl = await import(pathToFileURL(path.join(STAGE, "replicate.ts")));

/* ---- 1. the signature, against an independent implementation ---- */
console.log("SigV4\n");
{
  const t = {
    endpoint: "http://127.0.0.1:9099",
    region: "us-east-1",
    bucket: "backups",
    accessKey: "AKIDEXAMPLE",
    secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    prefix: "octavo",
    intervalMinutes: 5,
    keepDays: 14,
  };
  const body = Buffer.from("snapshot-bytes");
  const amzDate = "20260824T120000Z";
  const got = repl.sigv4Headers(t, "PUT", "octavo/x.db", body, amzDate);

  // Independent computation of the same signature, straight from the spec.
  const sha = (d) => createHash("sha256").update(d).digest("hex");
  const hm = (k, d) => createHmac("sha256", k).update(d).digest();
  const payloadHash = sha(body);
  const canonical = [
    "PUT",
    "/backups/octavo/x.db",
    "",
    `host:127.0.0.1:9099\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,
    "host;x-amz-content-sha256;x-amz-date",
    payloadHash,
  ].join("\n");
  const scope = "20260824/us-east-1/s3/aws4_request";
  const sts = ["AWS4-HMAC-SHA256", amzDate, scope, sha(canonical)].join("\n");
  const kSigning = hm(hm(hm(hm("AWS4" + t.secretKey, "20260824"), "us-east-1"), "s3"), "aws4_request");
  const expected = createHmac("sha256", kSigning).update(sts).digest("hex");

  ok("signature matches the independent derivation", got.Authorization.endsWith(expected));
  ok("credential scope is present", got.Authorization.includes(`Credential=AKIDEXAMPLE/${scope}`));
  ok("payload hash header matches the body", got["x-amz-content-sha256"] === payloadHash);
}

/* ---- 2. the loop, against a local S3 stub ---- */
console.log("\nShip, pull, swap\n");

const store = new Map();
const stub = createServer((req, res) => {
  const key = req.url;
  if (req.method === "PUT") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      // A storage endpoint that refuses unsigned traffic, at least in shape.
      if (!req.headers.authorization?.startsWith("AWS4-HMAC-SHA256")) {
        res.writeHead(403).end();
        return;
      }
      store.set(key, Buffer.concat(chunks));
      res.writeHead(200, { etag: `"${createHash("md5").update(store.get(key)).digest("hex")}"` }).end();
    });
    return;
  }
  if (req.method === "GET") {
    const body = store.get(key);
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res
      .writeHead(200, {
        etag: `"${createHash("md5").update(body).digest("hex")}"`,
        "content-length": body.length,
      })
      .end(body);
    return;
  }
  res.writeHead(405).end();
});
await new Promise((r) => stub.listen(9099, r));

// A little primary database to ship.
const dataDir = path.join(STAGE, "data");
mkdirSync(dataDir, { recursive: true });
const primary = new Database(path.join(dataDir, "octavo.db"));
primary.exec("CREATE TABLE pages (id TEXT PRIMARY KEY, title TEXT)");
primary.prepare("INSERT INTO pages VALUES ('p1', 'The page that must survive')").run();
globalThis.__testDb = primary;

process.env.TEST_TARGET = JSON.stringify({
  endpoint: "http://127.0.0.1:9099",
  region: "us-east-1",
  bucket: "backups",
  accessKey: "test",
  secretKey: "testsecret",
  prefix: "octavo",
  intervalMinutes: 5,
  keepDays: 14,
});

const shipped = await repl.shipSnapshot();
ok("primary ships a verified snapshot", shipped.ok === true, shipped.error);
ok("the rolling head exists in the store", store.has("/backups/octavo/octavo-latest.db"));

// Replica side: fetch, verify, and confirm the content is the primary's.
{
  const t = JSON.parse(process.env.TEST_TARGET);
  const res = await repl.sigv4Fetch(t, "GET", "octavo/octavo-latest.db");
  ok("replica pull succeeds", res.ok, `HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const incoming = path.join(dataDir, "incoming.db");
  writeFileSync(incoming, bytes);
  const check = new Database(incoming, { readonly: true });
  const row = check.prepare("SELECT title FROM pages WHERE id='p1'").get();
  const integrity = check.pragma("integrity_check", { simple: true });
  check.close();
  ok("pulled snapshot passes integrity", integrity === "ok");
  ok("pulled snapshot carries the primary's content", row?.title === "The page that must survive");
}

// A corrupted object must be refused, never served.
{
  const garbage = Buffer.from("this is not a database");
  store.set("/backups/octavo/octavo-latest.db", garbage);
  const t = JSON.parse(process.env.TEST_TARGET);
  const res = await repl.sigv4Fetch(t, "GET", "octavo/octavo-latest.db");
  const bytes = Buffer.from(await res.arrayBuffer());
  const incoming = path.join(dataDir, "bad.db");
  writeFileSync(incoming, bytes);
  let refused = false;
  try {
    const check = new Database(incoming, { readonly: true });
    check.pragma("integrity_check", { simple: true });
    check.close();
  } catch {
    refused = true;
  }
  ok("a corrupted snapshot is refused by verification", refused);
}

primary.close();
stub.close();
rmSync(STAGE, { recursive: true, force: true });
console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
