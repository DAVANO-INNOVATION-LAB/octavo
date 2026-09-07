// Find uploaded files that nothing in the library refers to any more.
//
// Deleting a page never deleted what was attached to it, which is the right
// default — an attachment can outlive the page that first carried it, and a
// destructive cleanup that runs automatically is how people lose things. The
// residue is real though: files nothing references, still on disk, still
// counted in the backup, still served to anyone the access rule happens to
// allow.
//
// Two rules make this safe to run:
//
//   1. A file is an orphan only if NO text column of ANY table mentions it.
//      Not just pages — history, comments, settings, a site's dress. Scanning
//      the tables it "should" be in is how a sweep eats something.
//   2. A file younger than the grace period is never touched, however
//      unreferenced it looks. An upload that has just been made and not yet
//      placed on a page is indistinguishable from an orphan.
//
// Usage:
//   node scripts/sweep-uploads.mjs                 report only, changes nothing
//   node scripts/sweep-uploads.mjs --quarantine    move orphans aside, recoverable
//   node scripts/sweep-uploads.mjs --restore       put a quarantine back
//   node scripts/sweep-uploads.mjs --purge         delete a quarantine for good
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DATA = process.env.OCTAVO_DATA_DIR ?? path.join(process.cwd(), "data");
const UPLOADS = path.join(DATA, "uploads");
const QUARANTINE = path.join(DATA, "uploads-quarantine");
const GRACE_DAYS = Number(process.env.SWEEP_GRACE_DAYS ?? "7");

const mode = process.argv.includes("--quarantine") ? "quarantine"
  : process.argv.includes("--restore") ? "restore"
  : process.argv.includes("--purge") ? "purge"
  : "report";

const db = new Database(path.join(DATA, "octavo.db"), { readonly: mode === "report" });

/* ---- restore / purge act on the quarantine and stop ---- */
if (mode === "restore" || mode === "purge") {
  if (!fs.existsSync(QUARANTINE)) {
    console.log("Nothing is quarantined.");
    process.exit(0);
  }
  const names = fs.readdirSync(QUARANTINE).filter((n) => !n.startsWith("."));
  for (const n of names) {
    if (mode === "restore") fs.renameSync(path.join(QUARANTINE, n), path.join(UPLOADS, n));
    else fs.rmSync(path.join(QUARANTINE, n), { force: true });
  }
  // rmSync, not rmdirSync: the recursive option was removed from rmdirSync,
  // and a recovery path that throws after doing the work is not a recovery
  // path — it reads as a failure and invites someone to run it twice.
  fs.rmSync(QUARANTINE, { recursive: true, force: true });
  console.log(`${mode === "restore" ? "Restored" : "Purged"} ${names.length} file(s).`);
  process.exit(0);
}

/* ---- every name mentioned anywhere at all ---- */
const REF = /([0-9a-z]{8,}\.[0-9a-z]{1,8})/g;
const referenced = new Set();
const whereSeen = new Map();

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
for (const t of tables) {
  let cols;
  try { cols = db.prepare(`PRAGMA table_info("${t}")`).all(); } catch { continue; }
  for (const c of cols) {
    // Scan every column, whatever it claims to hold. A URL pasted into a
    // comment, a cover, a setting, a site's blurb all count.
    let rows;
    try {
      rows = db.prepare(`SELECT "${c.name}" AS v FROM "${t}" WHERE "${c.name}" LIKE '%/api/files/%' OR "${c.name}" LIKE '%uploads/%'`).all();
    } catch { continue; }
    for (const row of rows) {
      for (const m of String(row.v).matchAll(REF)) {
        referenced.add(m[1]);
        if (!whereSeen.has(m[1])) whereSeen.set(m[1], `${t}.${c.name}`);
      }
    }
  }
}
// upload_refs names the file directly rather than inside a URL.
for (const r of db.prepare("SELECT DISTINCT name FROM upload_refs").all()) {
  referenced.add(r.name);
  if (!whereSeen.has(r.name)) whereSeen.set(r.name, "upload_refs");
}

/* ---- what is on disk ---- */
if (!fs.existsSync(UPLOADS)) { console.log("No uploads directory."); process.exit(0); }
const now = Date.now();
const graceMs = GRACE_DAYS * 86400_000;

const kept = [], young = [], orphans = [];
let orphanBytes = 0, totalBytes = 0;
for (const name of fs.readdirSync(UPLOADS)) {
  if (name.startsWith(".")) continue;
  const full = path.join(UPLOADS, name);
  let st;
  try { st = fs.statSync(full); } catch { continue; }
  if (!st.isFile()) continue;
  totalBytes += st.size;
  const ageDays = Math.floor((now - st.mtimeMs) / 86400_000);
  if (referenced.has(name)) { kept.push({ name, by: whereSeen.get(name) }); continue; }
  if (now - st.mtimeMs < graceMs) { young.push({ name, ageDays }); continue; }
  orphans.push({ name, size: st.size, ageDays });
  orphanBytes += st.size;
}

const kb = (b) => `${(b / 1024).toFixed(1)} KB`;
console.log(`\nUploads in ${UPLOADS}`);
console.log(`  ${kept.length + young.length + orphans.length} files, ${kb(totalBytes)} total\n`);
console.log(`  referenced and kept   ${kept.length}`);
console.log(`  too new to judge      ${young.length}  (younger than ${GRACE_DAYS} days)`);
console.log(`  unreferenced          ${orphans.length}  (${kb(orphanBytes)})\n`);

if (orphans.length) {
  console.log("  Nothing in the library refers to these:");
  for (const o of orphans.sort((a, b) => b.size - a.size))
    console.log(`    ${o.name.padEnd(24)} ${kb(o.size).padStart(10)}   ${o.ageDays}d old`);
}
if (young.length) {
  console.log("\n  Left alone because they are recent:");
  for (const y of young) console.log(`    ${y.name.padEnd(24)} ${y.ageDays}d old`);
}

if (mode === "report") {
  console.log(
    orphans.length
      ? `\nNothing has been changed. Run with --quarantine to move those ${orphans.length} aside.`
      : "\nNothing to sweep."
  );
  process.exit(0);
}

/* ---- quarantine: recoverable by construction ---- */
fs.mkdirSync(QUARANTINE, { recursive: true });
for (const o of orphans) fs.renameSync(path.join(UPLOADS, o.name), path.join(QUARANTINE, o.name));
const clear = db.prepare("DELETE FROM uploads WHERE name = ?");
for (const o of orphans) clear.run(o.name);
console.log(`\nMoved ${orphans.length} file(s) to ${QUARANTINE}.`);
console.log("They are out of the library but not destroyed.");
console.log("  node scripts/sweep-uploads.mjs --restore   put them back");
console.log("  node scripts/sweep-uploads.mjs --purge     delete them for good");
