import "server-only";
import { getDb } from "./db";
import type { User } from "./auth";
import { canEditSpace, isAgent, may } from "./roles";
import { isDeactivated } from "./scim";
import { savePage } from "./data";
import { completeReview, reviewState, reviewRevision, type ReviewRecord } from "./document-review";
import { qualityRevision, reviewFor, reviewInput, type QualityPage, type PublishPolicy } from "./quality-checks";
import { contentDigest, documentReferences, reviewDate } from "./quality-core";
import { recordAudit, type AuditAction } from "./audit";
import { newId } from "./util";

export function requireQualityUser(user: User | null): asserts user is User {
  if (!user || isAgent(user) || isDeactivated(user.id)) throw new Error("Sign in with an active editor account");
}
export function editablePage(user: User | null, id: string): QualityPage {
  requireQualityUser(user);
  const p=getDb().prepare(`SELECT p.* FROM pages p JOIN spaces s ON s.id=p.space_id
    WHERE p.id=? AND s.id NOT IN (SELECT space_id FROM deleted_spaces)`).get(id) as QualityPage|undefined;
  if(!p || !canEditSpace(user,p.space_id)) throw new Error("Page not found or editing is not permitted");
  return p;
}
export function qualityPages(user: User) {
  requireQualityUser(user);
  const rows=getDb().prepare(`SELECT p.*, s.name AS space_name, s.slug AS space_slug FROM pages p
    JOIN spaces s ON s.id=p.space_id WHERE s.id NOT IN (SELECT space_id FROM deleted_spaces) ORDER BY s.name,p.title`).all() as (QualityPage & {space_name:string;space_slug:string})[];
  const access = new Map<string, boolean>();
  const reviews = new Map((getDb().prepare(`SELECT page_id, owner_id AS ownerId, due_at AS dueAt,
    verified_at AS verifiedAt, verified_by AS verifiedBy, verified_revision AS verifiedRevision FROM document_reviews`).all() as (ReviewRecord & {page_id:string})[]).map(r=>[r.page_id,r]));
  const timestamp = Date.now();
  return rows.filter(p=>{
    if (!access.has(p.space_id)) access.set(p.space_id,canEditSpace(user,p.space_id));
    return access.get(p.space_id);
  }).map(p=>{
    const review=reviews.get(p.id)??null, input=reviewInput(p);
    return {...p,review,state:reviewState(input,review,timestamp),revision:reviewRevision(input)};
  });
}
export function eligibleOwners(spaceId:string): User[] {
  return (getDb().prepare("SELECT id,email,name,role FROM users ORDER BY name").all() as User[])
    .filter(u=>!isAgent(u)&&!isDeactivated(u.id)&&canEditSpace(u,spaceId));
}
function ownerId(value:string,spaceId:string): string|null {
  if(!value) return null;
  if(!eligibleOwners(spaceId).some(u=>u.id===value)) throw new Error("Choose an active editor of this space");
  return value;
}
function audit(user:User,p:QualityPage,action:AuditAction,detail:Record<string,unknown>={}) {
  recordAudit({actor:user,action,objectType:"page",objectId:p.id,objectLabel:p.title,spaceId:p.space_id,detail});
}
export function updateQuality(user:User|null,form:FormData) {
  requireQualityUser(user);
  const field=(key:string)=>String(form.get(key)??"");
  const operation=field("operation");
  return getDb().transaction(()=>{
    const db=getDb(), p=editablePage(user,field("pageId"));
    const revision=qualityRevision(p);
    if (field("revision")!==revision) throw new Error("Page changed. Reload and review the latest revision");
    if(operation==="assign") {
      const owner=ownerId(field("ownerId"),p.space_id), due=reviewDate(field("due"));
      db.prepare(`INSERT INTO document_reviews(page_id,owner_id,due_at) VALUES(?,?,?)
        ON CONFLICT(page_id) DO UPDATE SET owner_id=excluded.owner_id,due_at=excluded.due_at`).run(p.id,owner,due);
      audit(user,p,"document.assigned",{owner,due});
    } else if(operation==="verify") {
      const r=completeReview({page:reviewInput(p),previous:reviewFor(p.id),expectedRevision:revision,reviewerId:user.id,now:Date.now(),nextDueAt:reviewDate(field("due"))});
      db.prepare(`INSERT INTO document_reviews(page_id,owner_id,due_at,verified_at,verified_by,verified_revision) VALUES(?,?,?,?,?,?)
        ON CONFLICT(page_id) DO UPDATE SET due_at=excluded.due_at,verified_at=excluded.verified_at,verified_by=excluded.verified_by,verified_revision=excluded.verified_revision`)
        .run(p.id,r.ownerId,r.dueAt,r.verifiedAt,r.verifiedBy,r.verifiedRevision);
      audit(user,p,"document.reviewed",{revision});
    } else if(operation==="approve") {
      if(!may(user,p.space_id,"publish") || !p.updated_by || p.updated_by===user.id) throw new Error("Approval requires a different publisher from the recorded author");
      db.prepare(`INSERT INTO document_approvals(page_id,reviewer_id,revision,at) VALUES(?,?,?,?)
        ON CONFLICT(page_id) DO UPDATE SET reviewer_id=excluded.reviewer_id,revision=excluded.revision,at=excluded.at`).run(p.id,user.id,revision,Date.now());
      audit(user,p,"document.approved",{revision});
    } else if(operation==="policy") {
      if(!may(user,p.space_id,"administer")) throw new Error("Space administration is required");
      const policy:PublishPolicy={required:field("required").split("\n").map(x=>x.trim()).filter(Boolean).slice(0,30),review:form.has("review"),approval:form.has("approval"),links:form.has("links")};
      db.prepare("INSERT INTO quality_policies(space_id,policy) VALUES(?,?) ON CONFLICT(space_id) DO UPDATE SET policy=excluded.policy").run(p.space_id,JSON.stringify(policy));
      audit(user,p,"quality.policy_changed",policy);
    } else if(operation==="reusable") {
      if(form.has("enabled")) db.prepare("INSERT OR IGNORE INTO reusable_pages(page_id) VALUES(?)").run(p.id);
      else db.prepare("DELETE FROM reusable_pages WHERE page_id=?").run(p.id);
      audit(user,p,"document.reused",{enabled:form.has("enabled")});
    } else if(operation==="insert") {
      const source=editablePage(user,field("sourceId"));
      if(source.id===p.id || !source.published || !db.prepare("SELECT 1 FROM reusable_pages WHERE page_id=?").get(source.id)) throw new Error("Choose a published reusable source");
      if(documentReferences(source.content).some(r=>r.kind==="synced")) throw new Error("Reusable sources cannot contain nested synced pages");
      const targetVisibility=(db.prepare("SELECT visibility FROM spaces WHERE id=?").get(p.space_id) as {visibility:string}).visibility;
      const sourceVisibility=(db.prepare("SELECT visibility FROM spaces WHERE id=?").get(source.space_id) as {visibility:string}).visibility;
      if(targetVisibility==="public"&&sourceVisibility!=="public") throw new Error("Public documents require a public reusable source");
      const blocks=JSON.parse(p.content); blocks.push({id:newId(),type:"syncedPage",props:{pageId:source.id},content:[],children:[]});
      savePage(p.id,{content:JSON.stringify(blocks),by:user.id}); audit(user,p,"document.reused",{source:source.id});
    } else if(operation==="feedback") {
      const id=field("feedbackId"),status=field("status"),resolution=field("resolution").trim().slice(0,2000);
      if(!db.prepare("SELECT 1 FROM feedback WHERE id=? AND page_id=?").get(id,p.id)) throw new Error("Feedback not found");
      if(!["open","in_progress","resolved"].includes(status)||status==="resolved"&&!resolution) throw new Error("Resolving feedback requires a resolution note");
      const owner=ownerId(field("ownerId"),p.space_id);
      db.prepare(`INSERT INTO feedback_triage(feedback_id,owner_id,status,resolution,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(feedback_id) DO UPDATE SET owner_id=excluded.owner_id,status=excluded.status,resolution=excluded.resolution,updated_at=excluded.updated_at`).run(id,owner,status,resolution,Date.now());
      audit(user,p,"feedback.triaged",{id,status,owner});
    } else if(operation==="check") {
      const name=field("name").trim(),command=field("command").trim(),expected=field("expected");
      if(!name||!command||!expected||name.length>120||command.length>4000||expected.length>4000) throw new Error("Supply a name, command, and expected output within the limits");
      db.prepare("INSERT INTO runbook_checks(id,page_id,name,command,expected) VALUES(?,?,?,?,?)").run(newId(),p.id,name,command,expected);
      audit(user,p,"runbook.recorded",{definition:name});
    } else if(operation==="evidence") {
      const evidence=JSON.parse(field("evidence"));
      const check=db.prepare("SELECT * FROM runbook_checks WHERE id=? AND page_id=?").get(evidence.checkId,p.id) as RunbookCheck|undefined;
      if(!check||evidence.revision!==revision||evidence.definition!==checkDigest(check)||typeof evidence.output!=="string"||evidence.output.length>64000||!Number.isInteger(evidence.exitCode)) throw new Error("Evidence does not match this page and check, or exceeds the size limit");
      const passed=evidence.exitCode===0&&evidence.output.includes(check.expected);
      db.prepare("INSERT INTO runbook_evidence(id,check_id,revision,definition,passed,output,recorded_by,at) VALUES(?,?,?,?,?,?,?,?)").run(newId(),check.id,revision,checkDigest(check),passed?1:0,evidence.output,user.id,Date.now());
      audit(user,p,"runbook.recorded",{check:check.id,passed,provenance:"user-submitted execution evidence"});
    } else throw new Error("Unknown operation");
    return p.id;
  }).immediate();
}
export type RunbookCheck={id:string;page_id:string;name:string;command:string;expected:string};
export function checkDigest(c:RunbookCheck) {return contentDigest(JSON.stringify([c.command,c.expected]));}
