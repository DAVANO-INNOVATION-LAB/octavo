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
import { cp, mkdir, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
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

if (failed) process.exit(1);
console.log("Offline assets are in place.");
