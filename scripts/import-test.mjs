// Import fidelity: put a real export in, look at what actually landed.
//
// The unit tests prove each reader in isolation. They cannot prove that a zip
// someone exported from Notion or Confluence becomes a readable space with its
// tree, its titles and its links intact — which is the only thing a person
// migrating actually cares about. This drives the real HTTP import and then
// reads the database back.
//
// Usage: node scripts/import-test.mjs [baseUrl]
import Database from "better-sqlite3";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

const BASE = process.argv[2] ?? "http://localhost:8541";
const db = new Database(path.join(process.cwd(), "data", "octavo.db"));

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

const session = db.prepare("SELECT id FROM sessions ORDER BY expires_at DESC LIMIT 1").get();
if (!session) { console.error("No session — sign in once first."); process.exit(1); }

/* ---- a minimal zip writer, so the fixtures are real zips ---- */
function zip(files) {
  const chunks = [], central = [];
  let offset = 0;
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return t;
  })();
  const crc32 = (buf) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  for (const [name, dataIn] of files) {
    const data = Buffer.isBuffer(dataIn) ? dataIn : Buffer.from(dataIn, "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const comp = deflateRawSync(data);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(0, 12);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(0, 42);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const body = Buffer.concat(chunks);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cd, end]);
}

async function importZip(fileName, buf, spaceName) {
  const form = new FormData();
  form.append("file", new Blob([buf]), fileName);
  form.append("name", spaceName);
  const res = await fetch(`${BASE}/api/import`, {
    method: "POST",
    headers: { cookie: `octavo_session=${session.id}` },
    body: form,
    redirect: "manual",
  });
  const loc = res.headers.get("location") ?? "";
  return { status: res.status, slug: loc.split("/").filter(Boolean).pop() ?? "", loc };
}

// Read through a fresh connection each time. The import happens in the server
// process; a handle opened before it can hold a snapshot from before the write,
// and the test then reports an empty space as a broken importer.
const pagesOf = (slug) => {
  const fresh = new Database(path.join(process.cwd(), "data", "octavo.db"), { readonly: true });
  try {
    return fresh.prepare(
      `SELECT p.id, p.title, p.content, p.parent_id,
              (SELECT title FROM pages WHERE id = p.parent_id) AS parentTitle
         FROM pages p JOIN spaces s ON s.id = p.space_id WHERE s.slug = ?`
    ).all(slug);
  } finally {
    fresh.close();
  }
};

/* ================= Notion ================= */
console.log("\nNotion export\n");
{
  const ID_A = "1a2b3c4d5e6f70819293a4b5c6d7e8f9";
  const ID_B = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
  const buf = zip([
    [`Team Wiki ${ID_A}/Getting Started ${ID_B}.md`,
     `# Getting Started\n\nStatus: Published\nOwner: Ada Lovelace\n\nWelcome. See [the roadmap](Roadmap%20${ID_A}.md) for what is next.\n`],
    [`Team Wiki ${ID_A}/Roadmap ${ID_A}.md`,
     `# Roadmap\n\nThings we intend to do.\n`],
  ]);
  const r = await importZip("Export-abc.zip", buf, "");
  ok("a Notion zip imports", r.status === 303 && !r.loc.includes("error"), r.loc);
  const pages = pagesOf(r.slug);

  ok("titles arrive without Notion's id",
    pages.some((p) => p.title === "Getting Started") && pages.some((p) => p.title === "Roadmap"),
    pages.map((p) => p.title).join(" | "));
  ok("no title still carries a 32-hex id",
    !pages.some((p) => /[0-9a-f]{32}/i.test(p.title)),
    pages.map((p) => p.title).join(" | "));

  const start = pages.find((p) => p.title === "Getting Started");
  const body = start ? start.content : "";
  ok("database properties are kept, not left as broken prose",
    body.includes("Ada Lovelace") && body.includes("Published"));
  ok("an internal link points at the imported page, not the export filename",
    /\/[a-z0-9-]+\/roadmap/i.test(body) && !body.includes(`Roadmap%20${ID_A}.md`),
    (body.match(/"href":"[^"]*"/g) ?? []).join(" "));
}

/* ================= Confluence HTML ================= */
console.log("\nConfluence HTML export\n");
{
  const page = (title, body) =>
    `<html><head><title>Ops Handbook : ${title}</title></head><body>
     <div id="main-content" class="wiki-content">${body}</div></body></html>`;
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001" +
    "0d0a2db40000000049454e44ae426082", "hex");
  const buf = zip([
    ["index.html", `<html><head><title>Ops Handbook : Index</title></head><body><ul>
       <li><a href="Runbooks_1.html">Runbooks</a>
         <ul><li><a href="Restart_2.html">Restarting the service</a></li></ul></li>
     </ul></body></html>`],
    ["Runbooks_1.html", page("Runbooks", "<p>How we operate.</p>")],
    ["Restart_2.html", page("Restarting the service",
      "<h2>Steps</h2><ol><li>Drain</li><li>Restart</li></ol><p><img src=\"attachments/2/topology.png\" alt=\"Topology\"></p>")],
    ["attachments/2/topology.png", png],
  ]);
  const r = await importZip("ops-handbook-html.zip", buf, "");
  ok("a Confluence HTML zip imports", r.status === 303 && !r.loc.includes("error"), r.loc);
  const pages = pagesOf(r.slug);

  ok("both pages arrive with their real titles",
    pages.some((p) => p.title === "Runbooks") &&
    pages.some((p) => p.title === "Restarting the service"),
    pages.map((p) => p.title).join(" | "));
  const child = pages.find((p) => p.title === "Restarting the service");
  ok("the tree from index.html is preserved", child?.parentTitle === "Runbooks", String(child?.parentTitle));
  ok("body structure survives (a list of steps)", (child?.content ?? "").includes("Drain"));
  ok("an attachment became a real upload, not a broken relative link",
    /\/api\/files\/[A-Za-z0-9_-]+\.png/.test(child?.content ?? "") &&
    !(child?.content ?? "").includes("attachments/2/topology.png"),
    (child?.content ?? "").slice(0, 200));
}

/* ---- clean up the spaces this test created ---- */
const made = db.prepare(
  "SELECT id FROM spaces WHERE name IN ('Team Wiki','Ops Handbook') OR slug LIKE 'team-wiki%' OR slug LIKE 'ops-handbook%'"
).all();
for (const s of made) {
  db.prepare("DELETE FROM pages WHERE space_id = ?").run(s.id);
  db.prepare("DELETE FROM spaces WHERE id = ?").run(s.id);
}
console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
