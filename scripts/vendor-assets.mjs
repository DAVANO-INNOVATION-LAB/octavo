// Copy third-party runtime assets into public/ so the app never reaches the
// public internet for them.
//
// Excalidraw lazy-loads its fonts at runtime. When window.EXCALIDRAW_ASSET_PATH
// is unset it falls back to a CDN (see ASSETS_FALLBACK_URL in its bundle),
// which fails in an air-gapped network and leaks a request in any other. We
// vendor the fonts and point the asset path at ourselves instead.
//
// Runs from `npm run prebuild`, so a normal build always produces an image
// that is complete offline. Usage: node scripts/vendor-assets.mjs
import { cp, mkdir, rm, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import path from "node:path";

const root = process.cwd();

const JOBS = [
  {
    what: "Excalidraw fonts",
    from: "node_modules/@excalidraw/excalidraw/dist/prod/fonts",
    to: "public/excalidraw-assets/fonts",
  },
];

async function dirSize(dir) {
  let bytes = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    bytes += entry.isDirectory() ? await dirSize(full) : (await stat(full)).size;
  }
  return bytes;
}

/**
 * draw.io, vendored into the application.
 *
 * The editor cannot be a sidecar. An air-gapped site often cannot run one,
 * and a diagram tool that needs a second container to exist is a diagram
 * tool that is missing. So the webapp is served from this instance like any
 * other asset, and the feature simply works with nothing configured.
 *
 * Pinned by version and verified by digest: this is a build input, and a
 * build input that could change under us is a supply-chain problem.
 */
const DRAWIO = {
  version: "v31.3.1",
  url: "https://github.com/jgraph/drawio/releases/download/v31.3.1/draw.war",
  sha256: "ee66120c95e85e2952c8ca723fb3b8ddb2c8bf0def1b130f68b8265d85e16b3d",
  dest: "public/drawio",
};

/**
 * Paths that never load in the embedded editor, measured by tracing what it
 * actually requests. WEB-INF also carries Java servlet configuration and
 * placeholder credential files, which have no business in a static bundle.
 */
const DRAWIO_DROP = [
  /^WEB-INF\//,
  /^templates\//,
  /^plugins\//,
  /^js\/integrate\.min\.js$/,
  /^js\/viewer(-static)?\.min\.js$/,
  /^js\/diagramly\//,
  /^js\/grapheditor\//,
  /^js\/elk\//,
  /\.map$/,
];

/** Read a ZIP (a .war is one) without shelling out to unzip. */
function extractZip(buf, destDir, skip) {
  // Find the end-of-central-directory record, scanning back over any comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  let written = 0;
  let skipped = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;
    // A zip entry names its own path; one that climbs out is not honoured.
    if (name.includes("..") || name.startsWith("/")) { skipped++; continue; }
    if (skip.some((re) => re.test(name))) { skipped++; continue; }

    const lnLen = buf.readUInt16LE(localOff + 26);
    const leLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lnLen + leLen;
    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else { skipped++; continue; }

    const out = path.join(destDir, name);
    if (!out.startsWith(destDir + path.sep)) { skipped++; continue; }
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, data);
    written++;
  }
  return { written, skipped };
}

async function vendorDrawio() {
  const dest = path.join(root, DRAWIO.dest);
  const stamp = path.join(dest, ".version");
  if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === DRAWIO.version) {
    console.log(`  draw.io ${DRAWIO.version} already vendored`);
    return true;
  }

  console.log(`  fetching draw.io ${DRAWIO.version}…`);
  let buf;
  try {
    const res = await fetch(DRAWIO.url, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error(`  MISSING  draw.io — ${err.message}`);
    console.error("           The build needs it once; the image then serves it offline.");
    return false;
  }

  const digest = createHash("sha256").update(buf).digest("hex");
  if (digest !== DRAWIO.sha256) {
    console.error("  REFUSED  draw.io digest does not match the pinned value.");
    console.error(`           expected ${DRAWIO.sha256}`);
    console.error(`           got      ${digest}`);
    return false;
  }

  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  const { written, skipped } = extractZip(buf, dest, DRAWIO_DROP);
  await writeFile(stamp, DRAWIO.version + "\n");
  const mb = ((await dirSize(dest)) / 1024 / 1024).toFixed(0);
  console.log(`  vendored draw.io ${DRAWIO.version} -> ${DRAWIO.dest} (${written} files, ${skipped} skipped, ${mb} MB)`);
  return true;
}

let failed = false;
for (const job of JOBS) {
  const from = path.join(root, job.from);
  const to = path.join(root, job.to);
  if (!existsSync(from)) {
    console.error(`  MISSING  ${job.what} — nothing at ${job.from}`);
    console.error("           Run npm install first.");
    failed = true;
    continue;
  }
  // Replace wholesale so an upgraded dependency never leaves stale files.
  await rm(to, { recursive: true, force: true });
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
  const mb = ((await dirSize(to)) / 1024 / 1024).toFixed(1);
  console.log(`  vendored ${job.what} -> ${job.to} (${mb} MB)`);
}

if (!(await vendorDrawio())) failed = true;

if (failed) process.exit(1);
console.log("Offline assets are in place.");
