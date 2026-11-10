import "server-only";
import type { User } from "./auth";
import { may, isAgent } from "./roles";
import { isDeactivated } from "./scim";
import fs from "node:fs";
import path from "node:path";
import { getDb, UPLOADS_DIR } from "./db";
import { documentReferences, missingSections } from "./quality-core";
import { extractHeadings, parseBlocks } from "./blocks";
import { reviewRevision, reviewState, type ReviewRecord } from "./document-review";

export type QualityPage = { id: string; space_id: string; title: string; slug: string; content: string; updated_at: number; updated_by: string; published: number };
export type Finding = { reference: string; reason: string; blocking: boolean };
export type PublishPolicy = { required: string[]; review: boolean; approval: boolean; links: boolean };
export const NO_POLICY: PublishPolicy = { required: [], review: false, approval: false, links: false };
export function policyFor(spaceId: string): PublishPolicy {
  const row = getDb().prepare("SELECT policy FROM quality_policies WHERE space_id = ?").get(spaceId) as { policy: string } | undefined;
  return row ? JSON.parse(row.policy) : NO_POLICY;
}
export function hasPolicy(spaceId: string): boolean {
  const p = policyFor(spaceId); return p.review || p.approval || p.links || p.required.length > 0;
}
export function reviewFor(pageId: string): ReviewRecord | null {
  return (getDb().prepare(`SELECT owner_id AS ownerId, due_at AS dueAt, verified_at AS verifiedAt,
    verified_by AS verifiedBy, verified_revision AS verifiedRevision FROM document_reviews WHERE page_id = ?`).get(pageId) as ReviewRecord) ?? null;
}
/** Synced source edits also invalidate the consuming page's review. */
export function reviewInput(page: QualityPage) {
  const deps = documentReferences(page.content).filter(r => r.kind === "synced").map(r => {
    const source = getDb().prepare("SELECT title, content, published FROM pages WHERE id = ?").get(r.value);
    return [r.value, source ?? null];
  });
  return { title: page.title, content: JSON.stringify([page.content, deps]), updatedAt: page.updated_at };
}
export function qualityRevision(page: QualityPage): string { return reviewRevision(reviewInput(page)); }
export function pageFindings(page: QualityPage): Finding[] {
  const db = getDb();
  const space = db.prepare("SELECT slug, visibility FROM spaces WHERE id = ?").get(page.space_id) as {slug: string; visibility: string};
  const out: Finding[] = [];
  for (const ref of documentReferences(page.content)) {
    if (ref.kind === "synced") {
      const source = db.prepare(`SELECT p.published, s.visibility FROM pages p JOIN spaces s ON s.id=p.space_id
        WHERE p.id=? AND s.id NOT IN (SELECT space_id FROM deleted_spaces)`).get(ref.value) as {published: number; visibility: string} | undefined;
      if (!source || !source.published || (space.visibility === "public" && source.visibility !== "public"))
        out.push({ reference: ref.value, reason: "Synced source is missing, unpublished, or private", blocking: true });
      continue;
    }
    if (/^(https?:)?\/\//i.test(ref.value)) {
      out.push({ reference: ref.value, reason: "External URL — not checked", blocking: false }); continue;
    }
    if (/^(mailto:|tel:|data:)/i.test(ref.value)) continue;
    if (/^[a-z][\w+.-]*:/i.test(ref.value)) {
      out.push({ reference: ref.value, reason: "Unsupported URL scheme", blocking: true }); continue;
    }
    let url: URL;
    try { url = new URL(ref.value, `https://octavo.invalid/${space.slug}/${page.slug}`); } catch { continue; }
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); } catch { out.push({reference: ref.value, reason: "Invalid URL encoding", blocking: true}); continue; }
    if (pathname.startsWith("/api/files/")) {
      const name = pathname.slice(11);
      if (!/^[a-z0-9]+\.[a-z0-9]+$/i.test(name) || !fs.existsSync(path.join(UPLOADS_DIR, name)))
        out.push({ reference: ref.value, reason: "Missing attachment", blocking: true });
      continue;
    }
    const parts = pathname.split("/").filter(Boolean);
    const targetSpace = parts.length ? db.prepare("SELECT id FROM spaces WHERE slug=? AND id NOT IN (SELECT space_id FROM deleted_spaces)").get(parts[0]) as {id: string} | undefined : null;
    if (!targetSpace) {
      if (!parts.length || ["admin","quality","search","import","login","api","graph","ask","whiteboard","inbox"].includes(parts[0])) continue;
      out.push({reference: ref.value, reason: "Missing space or page", blocking: true}); continue;
    }
    if (parts.length < 2) continue;
    const target = db.prepare("SELECT id, content, published FROM pages WHERE space_id=? AND slug=?").get(targetSpace.id, parts[1]) as {id:string; content:string;published:number} | undefined;
    if (!target || (!target.published && target.id !== page.id)) out.push({reference: ref.value, reason: "Missing or unpublished page", blocking: true});
    else if (url.hash) {
      let anchor: string; try { anchor=decodeURIComponent(url.hash.slice(1)); } catch { anchor=url.hash.slice(1); }
      if (!extractHeadings(parseBlocks(target.content)).some(h=>h.id===anchor) && !target.content.includes(JSON.stringify(anchor)))
        out.push({reference:ref.value, reason:"Missing heading or block anchor", blocking:true});
    }
  }
  return out;
}
export function publishProblems(page: QualityPage): string[] {
  const p=policyFor(page.space_id); const out=missingSections(page.content,p.required).map(s=>`Missing section: ${s}`);
  if(p.review && reviewState(reviewInput(page),reviewFor(page.id),Date.now())!=="verified") out.push("A current document review is required");
  if(p.approval) {
    const approval=getDb().prepare("SELECT reviewer_id FROM document_approvals WHERE page_id=? AND revision=?").get(page.id,qualityRevision(page)) as {reviewer_id:string}|undefined;
    const reviewer=approval && getDb().prepare("SELECT id,email,name,role FROM users WHERE id=?").get(approval.reviewer_id) as User|undefined;
    if(!approval || !reviewer || isAgent(reviewer) || isDeactivated(reviewer.id) || !may(reviewer,page.space_id,"publish") || approval.reviewer_id===page.updated_by) out.push("An independent approval is required");
  }
  if(p.links) out.push(...pageFindings(page).filter(f=>f.blocking).map(f=>`${f.reason}: ${f.reference}`));
  return out;
}
