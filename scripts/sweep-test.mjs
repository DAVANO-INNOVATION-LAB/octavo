// The sweep must never take a file the library is still using.
//
// This is the only script in the repo that removes something a person put
// there. Its whole safety rests on one claim — that a referenced file is
// never selected — so that claim is tested against a throwaway data
// directory rather than trusted.
//
// Usage: node scripts/sweep-test.mjs
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

const DATA = path.join(process.cwd(), ".sweep-data");
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(path.join(DATA, "uploads"), { recursive: true });

const db = new Database(path.join(DATA, "octavo.db"));
db.exec(`
  CREATE TABLE spaces (id TEXT PRIMARY KEY, slug TEXT);
  CREATE TABLE pages (id TEXT PRIMARY KEY, space_id TEXT, content TEXT, cover TEXT);
  CREATE TABLE page_versions (id TEXT PRIMARY KEY, page_id TEXT, content TEXT);
  CREATE TABLE comments (id TEXT PRIMARY KEY, body TEXT);
  CREATE TABLE upload_refs (name TEXT, space_id TEXT, PRIMARY KEY (name, space_id));
  CREATE TABLE uploads (name TEXT PRIMARY KEY, uploaded_by TEXT, space_id TEXT, created_at INTEGER);
  INSERT INTO spaces VALUES ('s1', 'space');
`);

const old = Date.now() - 30 * 86400_000;
const write = (name, body, age = old) => {
  const p = path.join(DATA, "uploads", name);
  fs.writeFileSync(p, body);
  fs.utimesSync(p, new Date(age), new Date(age));
};

// Referenced five different ways, each of which must protect the file.
write("onpage0000000001.png", "A");
db.prepare("INSERT INTO pages VALUES ('p1','s1',?,'')").run('[{"url":"/api/files/onpage0000000001.png"}]');
write("inhistory000001.png", "B");
db.prepare("INSERT INTO page_versions VALUES ('v1','p1',?)").run('{"u":"/api/files/inhistory000001.png"}');
write("incomment0000001.png", "C");
db.prepare("INSERT INTO comments VALUES ('c1',?)").run("see /api/files/incomment0000001.png");
write("oncover000000001.png", "D");
db.prepare("INSERT INTO pages VALUES ('p2','s1','[]',?)").run("/api/files/oncover000000001.png");
write("inreftable000001.png", "E");
db.prepare("INSERT INTO upload_refs VALUES ('inreftable000001.png','s1')").run();

// Genuinely unreferenced, and old enough to judge.
write("orphan0000000001.png", "GONE");
// Unreferenced but recent: indistinguishable from an upload in progress.
write("recent0000000001.png", "NEW", Date.now());
db.close();

const run = (...args) =>
  execFileSync("node", ["scripts/sweep-uploads.mjs", ...args], {
    encoding: "utf8",
    env: { ...process.env, OCTAVO_DATA_DIR: DATA },
  });

const report = run();
ok("an unreferenced, settled file is found", /orphan0000000001\.png/.test(report));
ok("a recent file is left alone", /Left alone because they are recent[\s\S]*recent0000000001/.test(report));
for (const [name, how] of [
  ["onpage0000000001.png", "on a live page"],
  ["inhistory000001.png", "only in an old version"],
  ["incomment0000001.png", "only in a comment"],
  ["oncover000000001.png", "only as a page cover"],
  ["inreftable000001.png", "only in the reference table"],
]) {
  const listed = new RegExp(`refers to these:[\\s\\S]*${name.replace(".", "\\.")}`).test(report);
  ok(`a file ${how} is never selected`, !listed);
}
ok("the report changes nothing on its own",
  fs.existsSync(path.join(DATA, "uploads", "orphan0000000001.png")));

run("--quarantine");
ok("quarantining moves the orphan out of uploads",
  !fs.existsSync(path.join(DATA, "uploads", "orphan0000000001.png")));
ok("and nothing else moved", fs.readdirSync(path.join(DATA, "uploads")).length === 6,
  fs.readdirSync(path.join(DATA, "uploads")).join(","));
ok("the orphan still exists, out of the way",
  fs.existsSync(path.join(DATA, "uploads-quarantine", "orphan0000000001.png")));
ok("its bytes are intact",
  fs.readFileSync(path.join(DATA, "uploads-quarantine", "orphan0000000001.png"), "utf8") === "GONE");

const restored = run("--restore");
ok("a restore puts it back", fs.existsSync(path.join(DATA, "uploads", "orphan0000000001.png")));
ok("a restore reports what it did and does not throw", /Restored 1 file/.test(restored), restored.trim());

run("--quarantine");
run("--purge");
ok("a purge destroys it", !fs.existsSync(path.join(DATA, "uploads-quarantine")));
ok("and leaves the library alone", fs.readdirSync(path.join(DATA, "uploads")).length === 6);

fs.rmSync(DATA, { recursive: true, force: true });
console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
