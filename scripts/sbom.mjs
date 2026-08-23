// Generate a CycloneDX 1.5 bill of materials from the lockfile.
//
// Regulators and security questionnaires increasingly ask for one, and the
// answer should not depend on a scanning service being reachable or on a
// vendor tool being installed. The lockfile already records the exact
// resolved version and integrity hash of everything that ships; this reads it.
//
// Usage: node scripts/sbom.mjs [--prod] > sbom.cdx.json
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

const prodOnly = process.argv.includes("--prod");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));

/** npm records "node_modules/a/node_modules/b"; the component is the last segment. */
function nameFromPath(p) {
  const parts = p.split("node_modules/");
  return parts[parts.length - 1];
}

/**
 * A package URL identifies a component the way every downstream tool expects.
 * Scoped names keep their @, which must stay encoded in the purl namespace.
 */
function purl(name, version) {
  const at = name.lastIndexOf("/");
  if (name.startsWith("@") && at > 0) {
    const scope = encodeURIComponent(name.slice(0, at));
    return `pkg:npm/${scope}/${name.slice(at + 1)}@${version}`;
  }
  return `pkg:npm/${name}@${version}`;
}

/** npm integrity is "<alg>-<base64>"; CycloneDX wants the hex digest. */
function hashesFrom(integrity) {
  if (!integrity) return undefined;
  const out = [];
  for (const part of integrity.split(/\s+/)) {
    const [alg, b64] = part.split("-");
    if (!alg || !b64) continue;
    const map = { sha512: "SHA-512", sha384: "SHA-384", sha256: "SHA-256", sha1: "SHA-1" };
    if (!map[alg]) continue;
    out.push({ alg: map[alg], content: Buffer.from(b64, "base64").toString("hex") });
  }
  return out.length ? out : undefined;
}

const components = [];
const seen = new Set();
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (!path || path === "") continue;           // the root project itself
  if (prodOnly && (entry.dev || entry.devOptional)) continue;
  const name = entry.name ?? nameFromPath(path);
  const version = entry.version;
  if (!name || !version) continue;
  const key = `${name}@${version}`;
  if (seen.has(key)) continue;                  // the same version hoisted twice
  seen.add(key);
  components.push({
    type: "library",
    "bom-ref": purl(name, version),
    name,
    version,
    purl: purl(name, version),
    scope: entry.dev ? "optional" : "required",
    ...(entry.license ? { licenses: [{ license: { id: entry.license } }] } : {}),
    ...(hashesFrom(entry.integrity) ? { hashes: hashesFrom(entry.integrity) } : {}),
  });
}
components.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

// A stable serial for identical input, so two builds of the same commit
// produce the same document and a diff means something changed.
const serial = createHash("sha256")
  .update(JSON.stringify([pkg.name, pkg.version, components.map((c) => c.purl)]))
  .digest("hex");

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${serial.slice(0, 8)}-${serial.slice(8, 12)}-4${serial.slice(13, 16)}-a${serial.slice(17, 20)}-${serial.slice(20, 32)}`,
  version: 1,
  metadata: {
    timestamp: new Date(Number(process.env.SOURCE_DATE_EPOCH ?? 0) * 1000 || Date.now()).toISOString(),
    tools: { components: [{ type: "application", name: "octavo-sbom", version: pkg.version }] },
    component: {
      type: "application",
      "bom-ref": purl(pkg.name, pkg.version),
      name: pkg.name,
      version: pkg.version,
      purl: purl(pkg.name, pkg.version),
      description: pkg.description ?? "",
      ...(pkg.license ? { licenses: [{ license: { id: pkg.license } }] } : {}),
    },
  },
  components,
};

process.stdout.write(JSON.stringify(bom, null, 2) + "\n");
process.stderr.write(
  `${components.length} components${prodOnly ? " (production only)" : ""}\n`
);
