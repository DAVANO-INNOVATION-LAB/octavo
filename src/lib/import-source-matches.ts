import "server-only";
import crypto from "node:crypto";
import type { User } from "./auth";
import { getDb } from "./db";
import { getSpace, scopeClause } from "./data";
import { canReadSpace, canAdminSpace, scopeFor, isAgent } from "./roles";

export type ImportSourceMatches = {
  status: "complete" | "limited" | "unavailable";
  candidates: { spaceSlug: string; spaceName: string; receiptId: string; completedAt: number; sourceLabel: string }[];
  reason?: string;
};
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);

/** Exact original-byte fingerprints in currently readable/administered receipts.
 * This is advice only: never reuse, merge or delete imported content here.
 */
export function findImportSourceMatches(user: User | null, bytes: Buffer): ImportSourceMatches {
  if (!user || isAgent(user)) return { status: "unavailable", candidates: [], reason: "An editor account is required." };
  const result: ImportSourceMatches = { status: "complete", candidates: [] };
  try {
    const db = getDb(), scope = scopeClause(scopeFor(user), "s.visibility", "s.id", "s.tenant_id");
    // Restrict to current potential administrators before LIMIT. Hidden receipts
    // cannot consume the visible search budget or change its completeness flag.
    // These predicates mirror the grant union; the role helpers remain authority.
    const rows = db.prepare(`SELECT r.id,r.space_id,r.completed_at,length(CAST(r.report_json AS BLOB)) bytes
      FROM import_reports r JOIN spaces s ON s.id=r.space_id
      WHERE ${scope.sql}
      AND NOT EXISTS (SELECT 1 FROM space_members m WHERE m.space_id=s.id AND m.user_id=? AND m.role='agent')
      AND (?='admin' OR EXISTS (SELECT 1 FROM space_members m WHERE m.space_id=s.id AND m.user_id=? AND m.role='admin')
        OR EXISTS (SELECT 1 FROM group_space_roles g JOIN group_members m ON m.group_id=g.group_id WHERE g.space_id=s.id AND m.user_id=? AND g.role='admin'))
      ORDER BY r.completed_at DESC,r.id DESC LIMIT 101`).all(...scope.params,user.id,user.role,user.id,user.id) as {id:string;space_id:string;completed_at:number;bytes:number}[];
    const targetHash = crypto.createHash("sha256").update(bytes).digest("hex");
    let inspected = 0, parsedBytes = 0;
    const unavailable = () => { result.status = "limited"; result.reason = "Only a bounded set of valid, currently accessible upload receipts could be checked. More matches may exist."; };
    for (const row of rows) {
      const space = getSpace(row.space_id);
      if (!space || !canReadSpace(user,space) || !canAdminSpace(user,space.id)) continue;
      if (++inspected > 100) { unavailable(); break; }
      if (row.bytes > 1024*1024 || parsedBytes + row.bytes > 8*1024*1024) { unavailable(); continue; }
      parsedBytes += row.bytes;
      const stored = db.prepare("SELECT report_json FROM import_reports WHERE id=? AND space_id=? AND length(CAST(report_json AS BLOB))=?").get(row.id,space.id,row.bytes) as {report_json:string}|undefined;
      if (!stored) { unavailable(); continue; }
      let report: unknown;
      try { report = JSON.parse(stored.report_json); } catch { unavailable(); continue; }
      if (!object(report) || report.id !== row.id || report.spaceId !== space.id || report.completedAt !== row.completed_at || !integer(report.completedAt) || !Number.isFinite(new Date(report.completedAt).getTime()) || !object(report.source)) { unavailable(); continue; }
      // Existing receipts without fingerprints, and other import kinds, are not
      // members of the original-upload baseline set. Never invent a fingerprint.
      if (report.source.kind !== "upload" || report.provenance === undefined) continue;
      const p = report.provenance;
      if (!text(report.source.label,200) || !object(p) || p.schemaVersion !== 1 || p.capturedAt !== row.completed_at || !object(p.source) || p.source.id !== row.id || !hash(p.source.sha256) || !integer(p.source.bytes) || p.source.bytes > 100*1024*1024 || !object(p.converter) || p.converter.name !== "octavo/importUpload" || !text(p.converter.version,64) || !Array.isArray(p.pages) || !Array.isArray(p.attachments) || p.pages.length+p.attachments.length > 10000) { unavailable(); continue; }
      if (p.pages.some(v=>!object(v)||!text(v.pageId,200)||!hash(v.contentSha256)) || p.attachments.some(v=>!object(v)||!text(v.name,255)||/[\\/]/.test(v.name)||v.name==='.'||v.name==='..'||!integer(v.bytes)||!hash(v.sha256))) { unavailable(); continue; }
      if (p.source.sha256 !== targetHash || p.source.bytes !== bytes.length) continue;
      if (result.candidates.length === 10) { unavailable(); break; }
      result.candidates.push({spaceSlug:space.slug,spaceName:space.name,receiptId:row.id,completedAt:row.completed_at,sourceLabel:report.source.label});
    }
    return result;
  } catch {
    return {status:"unavailable",candidates:[],reason:"Source-match lookup could not be completed. Preview and import remain separate from this advisory check."};
  }
}
