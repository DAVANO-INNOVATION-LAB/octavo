import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { User } from "./auth";
import { getDb, UPLOADS_DIR } from "./db";
import { getSpace } from "./data";
import { canAdminSpace, canReadSpace } from "./roles";
import { getImportReport } from "./import-reports";
import type { ImportProvenance } from "./import-provenance";

type ItemStatus = "unchanged" | "changed" | "missing" | "unavailable";
export type ImportProvenanceVerificationResult = {
  status: "checked" | "unavailable";
  reason?: string;
  receiptId: string;
  checkedAt: number;
  source: { status: "not_checked"; reason: string };
  scope: string;
  pages: { pageId: string; status: ItemStatus; reason?: string }[];
  attachments: { name: string; status: ItemStatus; reason?: string }[];
  counts: Record<ItemStatus, number>;
};
const MAX_ITEMS = 10000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const digest = (bytes: string | Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 200): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const safeName = (value: unknown): value is string => text(value, 255) && value === path.basename(value) && !/[\\/]/.test(value) && value !== "." && value !== "..";

function baseline(value: unknown, receiptId: string): value is ImportProvenance {
  if (!object(value) || value.schemaVersion !== 1 || !integer(value.capturedAt) || !object(value.source) || !object(value.converter)) return false;
  if (value.source.id !== receiptId || !hash(value.source.sha256) || !integer(value.source.bytes) || value.source.bytes > 100 * 1024 * 1024) return false;
  if (value.converter.name !== "octavo/importUpload" || !text(value.converter.version, 64)) return false;
  if (!Array.isArray(value.pages) || !Array.isArray(value.attachments) || value.pages.length + value.attachments.length > MAX_ITEMS) return false;
  const pageIds = new Set<string>(), names = new Set<string>();
  for (const page of value.pages) {
    if (!object(page) || !text(page.pageId) || !hash(page.contentSha256) || pageIds.has(page.pageId)) return false;
    pageIds.add(page.pageId);
  }
  for (const file of value.attachments) {
    if (!object(file) || !safeName(file.name) || !integer(file.bytes) || !hash(file.sha256) || names.has(file.name)) return false;
    names.add(file.name);
  }
  return true;
}

/** Read-only, bounded comparison of recorded outputs in their original space.
 * Missing/moved/unattributed objects share one outcome. No cross-space lookup.
 */
export function verifyImportProvenance(user: User | null, spaceId: string): ImportProvenanceVerificationResult | null {
  const space = getSpace(spaceId);
  if (!space || !canReadSpace(user, space) || !canAdminSpace(user, spaceId)) return null;
  const db = getDb();
  const stored = db.prepare("SELECT id, length(CAST(report_json AS BLOB)) bytes FROM import_reports WHERE space_id=?").get(spaceId) as { id: string; bytes: number } | undefined;
  if (!stored) return null;
  const result: ImportProvenanceVerificationResult = {
    status: "unavailable", receiptId: stored.id, checkedAt: Date.now(),
    source: { status: "not_checked", reason: "The original upload was not retained and is not checked." },
    scope: "Only recorded outputs in this space are compared at this moment. Page hashes cover stored content, not titles or other metadata. New outputs are not checked. Changed content can reflect legitimate edits; this is not authenticity or tamper proof.",
    pages: [], attachments: [], counts: { unchanged: 0, changed: 0, missing: 0, unavailable: 0 },
  };
  if (stored.bytes > MAX_REPORT_BYTES) { result.reason = "The stored receipt exceeds the verification size limit."; return result; }
  let report;
  try { report = getImportReport(user, spaceId); }
  catch { result.reason = "The stored receipt cannot be read as a valid baseline."; return result; }
  if (!report) return null;
  if (report.provenance === undefined) { result.reason = "No provenance baseline was recorded for this import."; return result; }
  if (report.id !== stored.id || report.spaceId !== spaceId || !baseline(report.provenance, stored.id)) { result.reason = "The recorded provenance baseline is invalid or unsupported."; return result; }
  const provenance = report.provenance;
  let consumed = 0;
  const reserve = (bytes: number) => { if (!integer(bytes) || bytes > MAX_BYTES - consumed) return false; consumed += bytes; return true; };
  const sizeQuery = db.prepare("SELECT length(CAST(content AS BLOB)) bytes FROM pages WHERE id=? AND space_id=? AND space_id NOT IN (SELECT space_id FROM deleted_spaces)");
  const contentQuery = db.prepare("SELECT content FROM pages WHERE id=? AND space_id=? AND length(CAST(content AS BLOB))=? AND space_id NOT IN (SELECT space_id FROM deleted_spaces)");
  for (const page of provenance.pages) {
    const item: ImportProvenanceVerificationResult["pages"][number] = { pageId: page.pageId, status: "unavailable" };
    result.pages.push(item);
    const current = sizeQuery.get(page.pageId, spaceId) as { bytes: number } | undefined;
    if (!current) { item.status = "missing"; item.reason = "No current output is available in this space."; continue; }
    if (!reserve(current.bytes)) { item.reason = "Verification exceeded the 64 MiB total read limit."; continue; }
    const row = contentQuery.get(page.pageId, spaceId, current.bytes) as { content: string } | undefined;
    if (!row) { item.reason = "Content changed during verification or is no longer available in this space."; continue; }
    if (typeof row.content !== "string" || Buffer.byteLength(row.content) !== current.bytes) { item.reason = "Content changed during verification or could not be read safely."; continue; }
    item.status = digest(row.content) === page.contentSha256 ? "unchanged" : "changed";
  }
  const uploadQuery = db.prepare("SELECT 1 FROM uploads WHERE name=? AND space_id=?");
  for (const file of provenance.attachments) {
    const item: ImportProvenanceVerificationResult["attachments"][number] = { name: file.name, status: "unavailable" };
    result.attachments.push(item);
    if (!uploadQuery.get(file.name, spaceId)) { item.status = "missing"; item.reason = "No current output is available in this space."; continue; }
    let fd: number | undefined;
    try {
      const filename = path.join(UPLOADS_DIR, file.name), beforePath = fs.lstatSync(filename);
      if (!beforePath.isFile() || beforePath.isSymbolicLink()) throw new Error("unsafe");
      if (!reserve(beforePath.size)) { item.reason = "Verification exceeded the 64 MiB total read limit."; continue; }
      fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.dev !== beforePath.dev || before.ino !== beforePath.ino || before.size !== beforePath.size) throw new Error("changed");
      const hasher = crypto.createHash("sha256"), buffer = Buffer.alloc(65536);
      let bytes = 0, n: number;
      while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        bytes += n;
        if (bytes > before.size) throw new Error("changed");
        hasher.update(buffer.subarray(0, n));
      }
      const after = fs.fstatSync(fd), afterPath = fs.lstatSync(filename);
      if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || afterPath.dev !== before.dev || afterPath.ino !== before.ino || afterPath.isSymbolicLink()) throw new Error("changed");
      if (!uploadQuery.get(file.name, spaceId)) { item.status = "missing"; item.reason = "No current output is available in this space."; continue; }
      item.status = bytes === file.bytes && hasher.digest("hex") === file.sha256 ? "unchanged" : "changed";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { item.status = "missing"; item.reason = "No current output is available in this space."; }
      else item.reason = "The output was unreadable, unsafe, or changed during verification.";
    } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { item.status = "unavailable"; item.reason = "The output could not be read safely."; } } }
  }
  for (const item of [...result.pages, ...result.attachments]) result.counts[item.status]++;
  result.status = "checked";
  return result;
}
