import "server-only";
import crypto from "node:crypto";
import path from "node:path";
import type { ZipEntry } from "./zip";

export const PACKAGE_INVENTORY = "octavo-integrity.json";
export type PackageIntegrity = { status: "verified" | "unverified"; files?: number; reason?: string };
const MAX_ENTRIES = 10000;
const MAX_INVENTORY_BYTES = 2 * 1024 * 1024;
const hash = (data: Buffer) => crypto.createHash("sha256").update(data).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const basename = (name: string) => path.posix.basename(name.replaceAll("\\", "/").replace(/\/$/, ""));
function fail(reason: string): never { throw new Error(`Package integrity: ${reason}`); }
function canonical(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && Buffer.byteLength(name) <= 1024 && !/[\\:\x00-\x1f\x7f]/.test(name) && !name.startsWith("/") && name === name.normalize("NFC") && path.posix.normalize(name) === name && !name.split("/").includes("..") && name !== "." && name !== "./";
}
function validateNames(entries: ZipEntry[]): void {
  if (entries.length > MAX_ENTRIES) fail("too many archive entries");
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!canonical(entry.name)) fail("unsafe or noncanonical archive path");
    const key = entry.name.replace(/\/$/, "");
    if (seen.has(key)) fail("duplicate or ambiguous archive path");
    seen.add(key);
    if (entry.name.endsWith("/") && entry.data.length !== 0) fail("directory entry contains data");
  }
  const files = new Set(entries.filter(entry=>!entry.name.endsWith("/")).map(entry=>entry.name));
  for (const name of seen) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0,i).join("/");
      if (files.has(parent)) fail("file path is also used as a directory");
    }
  }
}

/** Returns null for unrelated ZIPs. Present inventories always fail closed. */
export function verifyPackageIntegrity(entries: ZipEntry[]): PackageIntegrity | null {
  const inventories = entries.filter(entry=>basename(entry.name).toLowerCase()===PACKAGE_INVENTORY);
  const manifests = entries.filter(entry=>basename(entry.name).toLowerCase()==="octavo.json");
  if (!inventories.length && !manifests.length) return null;
  validateNames(entries);
  if (manifests.length !== 1 || path.posix.basename(manifests[0].name) !== "octavo.json" || manifests[0].name.endsWith("/")) fail("expected exactly one canonical octavo.json manifest");
  if (!inventories.length) return {status:"unverified",reason:"This legacy package has no integrity inventory. Its contents are not checksum-verified."};
  if (inventories.length !== 1 || path.posix.basename(inventories[0].name) !== PACKAGE_INVENTORY || inventories[0].name.endsWith("/")) fail("ambiguous integrity inventory");
  const inventory = inventories[0];
  if (inventory.data.length > MAX_INVENTORY_BYTES) fail("inventory exceeds 2 MiB");
  let parsed: unknown;
  try { parsed = JSON.parse(inventory.data.toString("utf8")); } catch { fail("malformed inventory JSON"); }
  if (!object(parsed) || parsed.schemaVersion !== 1 || parsed.algorithm !== "sha256" || parsed.manifestPath !== manifests[0].name || path.posix.dirname(inventory.name) !== path.posix.dirname(manifests[0].name) || !Array.isArray(parsed.files) || parsed.files.length > MAX_ENTRIES) fail("unsupported or invalid inventory");
  const actual = new Map(entries.filter(entry=>entry!==inventory).map(entry=>[entry.name,entry.data]));
  if (parsed.files.length !== actual.size) fail("inventory does not cover the exact archive entries");
  const seen = new Set<string>();
  for (const item of parsed.files) {
    if (!object(item) || !canonical(item.path) || item.path === inventory.name || seen.has(item.path) || !Number.isSafeInteger(item.bytes) || (item.bytes as number) < 0 || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) fail("invalid inventory entry");
    seen.add(item.path);
    const data = actual.get(item.path);
    if (!data || data.length !== item.bytes || hash(data) !== item.sha256) fail("missing, extra or changed archive entry");
  }
  return {status:"verified",files:actual.size,reason:"Archive bytes match an unsigned inventory. This does not establish authenticity, trust, conversion fidelity or attachment completeness."};
}

export function addPackageIntegrity(entries: ZipEntry[], manifestPath: string): ZipEntry[] {
  validateNames(entries);
  if (entries.length >= MAX_ENTRIES || entries.some(entry=>basename(entry.name).toLowerCase()===PACKAGE_INVENTORY)) fail("ambiguous or excessive export entries");
  const inventoryPath = path.posix.join(path.posix.dirname(manifestPath),PACKAGE_INVENTORY);
  const data = Buffer.from(JSON.stringify({schemaVersion:1,algorithm:"sha256",manifestPath,files:entries.map(entry=>({path:entry.name,bytes:entry.data.length,sha256:hash(entry.data)}))},null,2));
  if (data.length > MAX_INVENTORY_BYTES) fail("inventory exceeds 2 MiB");
  const result = [...entries,{name:inventoryPath,data}];
  verifyPackageIntegrity(result);
  return result;
}
