import "server-only";
import path from "node:path";
import type { User } from "./auth";
import { getDb } from "./db";
import { getSpace } from "./data";
import { canAdminSpace, canReadSpace } from "./roles";
import { documentReferences } from "./quality-core";
import { newId } from "./util";

export type ImportReport = {
  id: string;
  spaceId: string;
  actorId: string | null;
  completedAt: number;
  source: { kind: "upload" | "url" | "openapi"; label: string };
  counts: { pages: number; published: number; drafts: number; indexed: number; attachmentsSaved: number };
  preview: { pages: number; attachmentEntries: number; assetPlan?: { files: number; bytes: number } } | null;
  warnings: string[];
  notes: string[];
};
export type ImportReportInput = {
  spaceId: string;
  actorId: string;
  sourceKind: ImportReport["source"]["kind"];
  sourceLabel: string;
  preview?: { pages: number; attachmentEntries: number; warnings?: string[]; assetPlan?: { files: number; bytes: number } };
};

/** A completion snapshot, committed with the import, never a fidelity certificate. */
export function createImportReport(input: ImportReportInput): ImportReport {
  const db = getDb();
  if (!db.inTransaction) throw new Error("Import report requires an active import transaction");
  const pages = db.prepare("SELECT id, content, published FROM pages WHERE space_id=?").all(input.spaceId) as { id: string; content: string; published: number }[];
  const published = pages.filter(p => p.published === 1).length;
  const indexed = (db.prepare(`SELECT COUNT(DISTINCT p.id) n FROM pages p JOIN pages_fts f ON f.page_id=p.id WHERE p.space_id=? AND p.published=1`).get(input.spaceId) as {n:number}).n;
  const attachmentsSaved = (db.prepare("SELECT COUNT(*) n FROM uploads WHERE space_id=?").get(input.spaceId) as {n:number}).n;
  const warnings: string[] = [];
  if (input.preview && input.preview.pages !== pages.length) warnings.push(`Preview estimated ${input.preview.pages} pages; ${pages.length} pages were created, including any folder pages.`);
  let relative = 0;
  for (const page of pages) for (const ref of documentReferences(page.content)) {
    if (ref.kind !== "synced" && ref.value && !/^(?:#|\/|[a-z][a-z0-9+.-]*:)/i.test(ref.value)) relative++;
  }
  if (relative) warnings.push(`${relative} relative link or resource references remain in the imported content. Review them in their new destination; source files may not have been transferred.`);
  warnings.push(...(input.preview?.warnings ?? []));
  let label: string;
  if (input.sourceKind === "url") {
    try { label = new URL(input.sourceLabel).hostname; } catch { label = "URL import"; }
  } else if (input.sourceKind === "openapi") label = "OpenAPI specification";
  else label = path.posix.basename(input.sourceLabel.replaceAll("\\", "/")).slice(0, 200);
  const notes = [
    "Snapshot at import completion. Later edits, publication changes and file changes are not reflected here.",
    "Counts describe stored results, not conversion fidelity or proof that every source item was imported.",
    "Attachments saved counts newly attributed upload records, not archive entries or remote resources. External resources are not downloaded.",
  ];
  if (input.sourceKind === "url") notes.push("URL import converts the fetched readable text. Page layout, scripts and linked media are not archived.");
  else if (input.sourceKind === "openapi") notes.push("OpenAPI import generates reference documentation, not a lossless copy of the specification; unsupported specification features may be omitted or simplified.");
  else {
    const extension = path.extname(label).toLowerCase();
    if (extension === ".ipynb") notes.push("Notebook conversion keeps Markdown, code, plain-text output and PNG output. Raw cells and unsupported rich outputs are omitted.");
    if (extension === ".docx") notes.push("Word conversion extracts paragraph text, headings and lists; formatting, embedded objects and media are not fully preserved.");
    if ([".zip", ".md", ".markdown", ".txt"].includes(extension)) notes.push("Markdown/Notion conversion may create draft folder pages. ZIP imports copy supported assets referenced by parsed content, not the entire bundle; missing or unsupported references may remain. Standalone Markdown imports do not include companion files. Confluence attachment conversion depends on the export format and available files.");
  }
  const report: ImportReport = {id:newId(),spaceId:input.spaceId,actorId:input.actorId,completedAt:Date.now(),source:{kind:input.sourceKind,label},counts:{pages:pages.length,published,drafts:pages.length-published,indexed,attachmentsSaved},preview:input.preview?{pages:input.preview.pages,attachmentEntries:input.preview.attachmentEntries,...(input.preview.assetPlan?{assetPlan:{files:input.preview.assetPlan.files,bytes:input.preview.assetPlan.bytes}}:{})}:null,warnings:[...new Set(warnings)].slice(0,200),notes};
  // Keep actor identity only in the nullable FK, so account erasure removes it.
  db.prepare("INSERT INTO import_reports(id,space_id,actor_id,completed_at,report_json) VALUES(?,?,?,?,?)").run(report.id,report.spaceId,report.actorId,report.completedAt,JSON.stringify({...report, actorId: null}));
  return report;
}

export function getImportReport(user: User | null, spaceId: string): ImportReport | null {
  const space = getSpace(spaceId);
  if (!space || !canReadSpace(user,space) || !canAdminSpace(user,spaceId)) return null;
  const row = getDb().prepare("SELECT report_json, actor_id FROM import_reports WHERE space_id=?").get(spaceId) as {report_json:string;actor_id:string|null}|undefined;
  if (!row) return null;
  return {...JSON.parse(row.report_json) as ImportReport,actorId:row.actor_id};
}

export type ImportHistoryItem = {
  report: ImportReport;
  space: { id: string; slug: string; name: string };
};
export type ImportHistoryPage = {
  items: ImportHistoryItem[];
  offset: number;
  limit: number;
  hasMore: boolean;
};

/** Offset counts only currently accessible reports, never hidden records.
 * Read bounded metadata batches first; parse receipt JSON only for the chosen
 * authorized page. There is intentionally no global or inaccessible total.
 */
export function listImportReports(
  user: User | null,
  options: { offset?: number; limit?: number } = {}
): ImportHistoryPage {
  const offset = Number.isSafeInteger(options.offset) && options.offset! >= 0 ? options.offset! : 0;
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(50, Math.floor(options.limit!))) : 20;
  const result: ImportHistoryPage = { items: [], offset, limit, hasMore: false };
  if (!user) return result;
  const db = getDb();
  type Candidate = { id: string; space_id: string; completed_at: number };
  let cursor: Candidate | undefined;
  let skipped = 0;
  for (;;) {
    const candidates = db.prepare(`SELECT r.id, r.space_id, r.completed_at
      FROM import_reports r JOIN spaces s ON s.id = r.space_id
      WHERE NOT EXISTS (SELECT 1 FROM deleted_spaces d WHERE d.space_id = s.id)
      ${cursor ? "AND (r.completed_at < ? OR (r.completed_at = ? AND r.id < ?))" : ""}
      ORDER BY r.completed_at DESC, r.id DESC LIMIT 100`).all(...(cursor ? [cursor.completed_at,cursor.completed_at,cursor.id] : [])) as Candidate[];
    if (!candidates.length) return result;
    for (const candidate of candidates) {
      const space = getSpace(candidate.space_id);
      if (!space || !canReadSpace(user,space) || !canAdminSpace(user,space.id)) continue;
      if (skipped < offset) { skipped++; continue; }
      if (result.items.length === limit) { result.hasMore = true; return result; }
      const report = getImportReport(user,space.id);
      if (report) result.items.push({report,space:{id:space.id,slug:space.slug,name:space.name}});
    }
    cursor = candidates[candidates.length-1];
    if (candidates.length < 100) return result;
  }
}
