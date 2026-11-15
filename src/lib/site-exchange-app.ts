import type {ExchangeAuthority} from "./site-exchange-authority";
import "server-only";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { SiteExchange, canonical } from "./site-exchange";
import { getDb, DATA_DIR, UPLOADS_DIR } from "./db";
import { createPage, getPage, getSpace, savePage, snapshotNow } from "./data";
import { fileNamesIn, recordUpload } from "./uploads";
import { portablePageLinks, localizePageLinks } from "./site-exchange-links";
import { archivePage, hasPageArchive, restorePageArchive, verifyPageArchive } from "./site-exchange-archive";

type Body = { title:string; content:string; parentDocId:string|null; deleted:boolean; attachments:string[] };
type Mapping = { lineage:string; doc_id:string; page_id:string; captured:string|null; hold:string|null };
const hash=(v:string|Buffer)=>createHash("sha256").update(v).digest("hex");
const assetPattern=/octavo-asset:([a-f0-9]{64})\.([a-z0-9]{1,12})/g;
export function exchangeEngine() {
 const db=getDb();
 db.exec(`CREATE TABLE IF NOT EXISTS site_exchange_pages(lineage TEXT NOT NULL,doc_id TEXT NOT NULL,page_id TEXT NOT NULL UNIQUE,captured TEXT,hold TEXT,PRIMARY KEY(lineage,doc_id));
 CREATE TABLE IF NOT EXISTS site_exchange_bindings(space_id TEXT PRIMARY KEY,lineage TEXT NOT NULL UNIQUE);
 CREATE TABLE IF NOT EXISTS site_exchange_holds(lineage TEXT NOT NULL,doc_id TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(lineage,doc_id));
 CREATE TABLE IF NOT EXISTS site_exchange_link_aliases(lineage TEXT NOT NULL,source_doc TEXT NOT NULL,path TEXT NOT NULL,target_doc TEXT NOT NULL,PRIMARY KEY(lineage,source_doc,path));`);
 const keyPath=path.join(DATA_DIR,"site-exchange-identity.json");
 if(!fs.existsSync(keyPath)) {
  const identity=SiteExchange.createIdentity();
  try{fs.writeFileSync(keyPath,JSON.stringify(identity),{mode:0o600,flag:"wx"});}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
 }
 const stat=fs.lstatSync(keyPath);
 if(!stat.isFile() || stat.isSymbolicLink() || (stat.mode&0o077)!==0)throw new Error("Site identity requires a private regular file");
 const identity=JSON.parse(fs.readFileSync(keyPath,"utf8"));
 return {db,engine:new SiteExchange(db,identity),identity};
}
function binding(spaceId:string) {
 const {db,engine}=exchangeEngine();const space=getSpace(spaceId);
 if(!space)throw new Error("Space unavailable");
 const row=db.prepare("SELECT lineage FROM site_exchange_bindings WHERE space_id=?").get(spaceId) as {lineage:string}|undefined;
 if(!row)throw new Error("Space is not bound to an exchange lineage");
 return {db,engine,space,lineage:row.lineage};
}
export function bindExchange(spaceId:string,lineage?:string) {
 const {db,engine}=exchangeEngine(),space=getSpace(spaceId);if(!space)throw new Error("Space unavailable");
 // Binding never grants access; require private target as safe setup default.
 if(space.visibility!=="private")throw new Error("Bind a private space; no publication rights are imported");
 const value=lineage||randomUUID();if(!/^[a-zA-Z0-9-]{16,128}$/.test(value))throw new Error("Invalid lineage");
 return db.transaction(()=>{engine.bindScope(spaceId,value);db.prepare("INSERT INTO site_exchange_bindings(space_id,lineage) VALUES(?,?)").run(spaceId,value);return {lineage:value};}).immediate();
}
function portableBody(pageId:string,lineage:string):Body {
 const {db,engine}=exchangeEngine(),page=getPage(pageId);if(!page)throw new Error("Page unavailable");
 const assets:string[]=[];let content=page.content;
 for(const name of fileNamesIn(content)) {
  if(!/^[a-z0-9]+\.[a-z0-9]{1,12}$/.test(name))throw new Error("Unsupported attachment name");
  const origin=db.prepare("SELECT space_id FROM uploads WHERE name=?").get(name) as {space_id:string|null}|undefined;
  if(origin?.space_id!==page.space_id)throw new Error("Attachment origin must match the bound space");
  const filename=path.join(UPLOADS_DIR,name),stat=fs.lstatSync(filename);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024)throw new Error("Attachment unavailable or too large");
  const bytes=fs.readFileSync(filename),digest=engine.putAsset(bytes),ext=name.split(".").pop()!;
  assets.push(digest);content=content.split(`/api/files/${name}`).join(`octavo-asset:${digest}.${ext}`);
  // Model data blocks can carry a bare generated filename.
  const parsed=JSON.parse(content),pending:unknown[]=Array.isArray(parsed)?[...parsed]:[];
  while(pending.length){const block=pending.pop();if(!block||typeof block!=="object")continue;
   const value=block as {type?:unknown;props?:{source?:unknown;dataUrl?:unknown};children?:unknown};
   if(value.type==="model3d"&&value.props?.source==="data"&&value.props.dataUrl===name)value.props.dataUrl=`octavo-asset:${digest}.${ext}`;
   if(Array.isArray(value.children))pending.push(...value.children);
  }
  content=JSON.stringify(parsed);
 }
 content=portablePageLinks(content,pageId,lineage,engine);
 const parent=page.parent_id?db.prepare("SELECT doc_id FROM site_exchange_pages WHERE lineage=? AND page_id=?").get(lineage,page.parent_id) as {doc_id:string}|undefined:undefined;
 if(page.parent_id&&!parent)throw new Error("Parent page outside the exchange scope");
 return {title:page.title,content,parentDocId:parent?.doc_id??null,deleted:false,attachments:[...new Set(assets)].sort()};
}
/** Snapshot-at-exchange, not a complete journal of every intermediate edit. */
export function captureExchange(spaceId:string) {
 const {db,engine,lineage}=binding(spaceId);
 return db.transaction(()=>{
  const pages=db.prepare("SELECT id FROM pages WHERE space_id=?").all(spaceId) as {id:string}[];
  for(const p of pages)db.prepare("INSERT OR IGNORE INTO site_exchange_pages(lineage,doc_id,page_id) VALUES(?,?,?)").run(lineage,randomUUID(),p.id);
  const mappings=db.prepare("SELECT * FROM site_exchange_pages WHERE lineage=?").all(lineage) as Mapping[];
  let captured=0;
  for(const m of mappings) {
   const page=getPage(m.page_id);
   if(!page&&hasPageArchive(m.page_id))continue;
   if(page&&page.space_id!==spaceId)throw new Error("Mapped page moved outside bound space; explicit migration required");
   const body:Body=page?portableBody(m.page_id,lineage):{title:"Deleted page",content:"[]",parentDocId:null,deleted:true,attachments:[]};
   const fingerprint=hash(JSON.stringify(body));
   if(fingerprint===m.captured)continue;
   engine.capture(lineage,m.doc_id,body);
   db.prepare("UPDATE site_exchange_pages SET captured=? WHERE lineage=? AND doc_id=?").run(fingerprint,lineage,m.doc_id);captured++;
  }
  return captured;
 }).immediate();
}
export function exportExchange(spaceId:string) {
 const {db,engine,lineage}=binding(spaceId);
 return db.transaction(()=>{captureExchange(spaceId);return engine.exportBundle(lineage);}).immediate();
}
/** Opt-in only: manual incremental integration remains experimental. */
export const incrementalExchangeEnabled=()=>process.env.OCTAVO_EXCHANGE_DELTA==="1";
function requireIncrementalExchange(){if(!incrementalExchangeEnabled())throw new Error("Incremental delta is not enabled");}
export function exportExchangeInventory(spaceId:string) {
 requireIncrementalExchange();const {db,engine,lineage}=binding(spaceId);
 return db.transaction(()=>{captureExchange(spaceId);return engine.exportInventory(lineage);}).immediate();
}
export function exportExchangeDelta(spaceId:string,inventory:string) {
 requireIncrementalExchange();const {db,engine,lineage}=binding(spaceId);
 return db.transaction(()=>{captureExchange(spaceId);return engine.exportDeltaBundle(lineage,inventory);}).immediate();
}
export function trustExchange(spaceId:string,publicKey:string) {const {engine,lineage}=binding(spaceId);return engine.trust(lineage,publicKey);}
export function revokeExchange(spaceId:string,peer:string) {const {engine,lineage}=binding(spaceId);return engine.revoke(lineage,peer);}

function localizeContent(engine:SiteExchange,spaceId:string,body:Body,actorId:string):string {
 const lineage=binding(spaceId).lineage;
 const linkedContent=localizePageLinks(body.content,spaceId,lineage,engine);
 if(body.content.includes('/api/files/'))throw new Error("Remote content contains unportable local file references");
 const referenced=new Set<string>();
 const content=linkedContent.replace(assetPattern,(_whole,digest:string,ext:string)=>{
  if(!body.attachments.includes(digest))throw new Error("Attachment reference is not declared");
  const bytes=engine.getAsset(digest);if(hash(bytes)!==digest)throw new Error("Stored attachment hash mismatch");
  referenced.add(digest);
  // Scope-specific names preserve upload provenance when identical bytes occur in separate spaces.
  const name=`${hash(spaceId+':'+digest)}.${ext}`,filename=path.join(UPLOADS_DIR,name);
  fs.mkdirSync(UPLOADS_DIR,{recursive:true});
  try{fs.writeFileSync(filename,bytes,{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
   const st=fs.lstatSync(filename);if(!st.isFile()||st.isSymbolicLink()||hash(fs.readFileSync(filename))!==digest)throw new Error("Attachment storage collision");}
  const existing=getDb().prepare("SELECT space_id FROM uploads WHERE name=?").get(name) as {space_id:string|null}|undefined;
  if(existing&&existing.space_id!==spaceId)throw new Error("Attachment origin collision");
  recordUpload(name,actorId,spaceId);
  return `/api/files/${name}`;
 });
 if(content.includes('octavo-asset:'))throw new Error("Invalid attachment reference");
 if(body.attachments.some(x=>!referenced.has(x)))throw new Error("Unreferenced attachment declaration");
 return content;
}
type Projector={seedSharedState:(content:string)=>Uint8Array;projectSharedState:(state:Uint8Array)=>string};
function semantic(value:string) {return canonical(JSON.parse(value));}
function applyAvailable(spaceId:string,actorId:string,projector:Projector) {
 const {db,engine,lineage}=binding(spaceId);const docs=[...new Set(engine.revisions(lineage).map(r=>r.docId))];let applied=0;
 const holds:{docId:string;reason:string}[]=[];
 db.prepare("DELETE FROM site_exchange_holds WHERE lineage=?").run(lineage);
 const pending=new Set(docs);
 for(let pass=0;pending.size&&pass<=docs.length;pass++) {
  let advanced=false;
  for(const docId of [...pending]) {
   const heads=engine.heads(lineage,docId);if(heads.length!==1){holds.push({docId,reason:"Concurrent revisions require explicit resolution"});pending.delete(docId);continue;}
   const head=heads[0];let mapping=db.prepare("SELECT * FROM site_exchange_pages WHERE lineage=? AND doc_id=?").get(lineage,docId) as Mapping|undefined;
   if(engine.applied(lineage,docId)===head.id&&mapping){pending.delete(docId);continue;}
   const body=head.body;
   if(body.deleted){holds.push({docId,reason:"Deletion is retained as a tombstone; explicit local deletion review required"});pending.delete(docId);continue;}
   let parentId:string|null=null;
   if(body.parentDocId) {
    if(body.parentDocId===docId){holds.push({docId,reason:"Parent cycle"});pending.delete(docId);continue;}
    const parent=db.prepare("SELECT page_id FROM site_exchange_pages WHERE lineage=? AND doc_id=?").get(lineage,body.parentDocId) as {page_id:string}|undefined;
    if(!parent||!getPage(parent.page_id))continue;
    const parentHeads=engine.heads(lineage,body.parentDocId);if(parentHeads.length!==1||parentHeads[0].body.deleted||engine.applied(lineage,body.parentDocId)!==parentHeads[0].id)continue;
    parentId=parent.page_id;
   }
   try {
    let page=mapping?getPage(mapping.page_id):null;
    if(mapping&&!page){const previous=engine.revisions(lineage,docId).find(r=>r.id===engine.applied(lineage,docId));if(!previous?.body.deleted)throw new Error("Local deletion conflicts with remote content");}
    if(page&&page.space_id!==spaceId)throw new Error("Mapped page moved outside bound space");
    if(page) {
     if(db.prepare("SELECT 1 FROM collab_room_leases WHERE page_id=? AND expires_at>?").get(page.id,Date.now()))throw new Error("Active editor must close and synchronize first");
     const shared=db.prepare("SELECT state FROM collab_docs WHERE page_id=?").get(page.id) as {state:Buffer}|undefined;
     if(shared&&(!shared.state.length||semantic(projector.projectSharedState(shared.state))!==semantic(projector.projectSharedState(projector.seedSharedState(page.content)))))throw new Error("Shared document diverges from saved page; recover first");
     let ancestor=parentId;const seen=new Set<string>();
     while(ancestor){if(ancestor===page.id||seen.has(ancestor))throw new Error("Parent cycle");seen.add(ancestor);ancestor=getPage(ancestor)?.parent_id??null;}
    }
    // Each application has a savepoint. Failed pages retain incoming revision and exact local data.
    db.transaction(()=>{
     if(mapping&&!page&&hasPageArchive(mapping.page_id)){restorePageArchive(mapping.page_id,spaceId);page=getPage(mapping.page_id);}
     const content=localizeContent(engine,spaceId,body,actorId),state=projector.seedSharedState(content);
     if(page){snapshotNow(page.id);savePage(page.id,{title:body.title,content,published:false,by:actorId});db.prepare("UPDATE pages SET parent_id=? WHERE id=?").run(parentId,page.id);}
     else {const created=createPage({spaceId,parentId,title:body.title,content,published:false});mapping={lineage,doc_id:docId,page_id:created.id,captured:null,hold:null};db.prepare("INSERT INTO site_exchange_pages(lineage,doc_id,page_id) VALUES(?,?,?) ON CONFLICT(lineage,doc_id) DO UPDATE SET page_id=excluded.page_id").run(lineage,docId,created.id);}
     const pageId=mapping!.page_id;
     db.prepare("UPDATE page_edit_versions SET epoch=epoch+1 WHERE page_id=?").run(pageId);
     db.prepare("INSERT INTO collab_docs(page_id,state,updated_at) VALUES(?,?,?) ON CONFLICT(page_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at").run(pageId,Buffer.from(state),Date.now());
     engine.setApplied(lineage,docId,head.id);
     db.prepare("UPDATE site_exchange_pages SET captured=?,hold=NULL WHERE lineage=? AND doc_id=?").run(hash(JSON.stringify(portableBody(pageId,lineage))),lineage,docId);
    })();
    applied++;advanced=true;pending.delete(docId);
   }catch(error){holds.push({docId,reason:error instanceof Error?error.message:"Document application failed"});pending.delete(docId);}
  }
  if(!advanced)break;
 }
 for(const docId of pending)holds.push({docId,reason:"Parent is missing, conflicted, deleted, or cyclic"});
 for(const h of holds){db.prepare("INSERT INTO site_exchange_holds(lineage,doc_id,reason) VALUES(?,?,?)").run(lineage,h.docId,h.reason);db.prepare("UPDATE site_exchange_pages SET hold=? WHERE lineage=? AND doc_id=?").run(h.reason,lineage,h.docId);}
 return {applied,holds};
}
export const stagingExchangeEnabled=()=>process.env.OCTAVO_EXCHANGE_STAGING==="1";
export function exchangeLineage(spaceId:string){return binding(spaceId).lineage;}
/** Validate against current local state inside an always-rolled-back transaction. Never projects pages. */
export function previewExchangeForStaging(spaceId:string,raw:string) {
 if(Buffer.byteLength(raw)>32*1024*1024)throw new Error("Bundle exceeds limit");
 const {db,engine,lineage}=binding(spaceId),parsed=JSON.parse(raw);
 if(parsed?.payload?.lineage!==lineage)throw new Error("Bundle lineage does not match selected space");
 if(parsed?.payload?.format!=="octavo-exchange-v1"&&!(incrementalExchangeEnabled()&&parsed?.payload?.format==="octavo-exchange-delta-v1"))throw new Error("Incremental delta is not enabled");
 const rollback=Symbol("verified");let summary;
 try{db.transaction(()=>{captureExchange(spaceId);engine.importBundle(raw);
  const revisions=engine.revisions(lineage),parents=new Set(revisions.flatMap(r=>r.parents));
  const grouped=new Map<string,typeof revisions>();for(const r of revisions){if(!grouped.has(r.docId))grouped.set(r.docId,[]);if(!parents.has(r.id))grouped.get(r.docId)!.push(r);}
  const docIds=[...grouped.keys()].sort();
  summary={format:parsed.payload.format,lineage,revisionCount:parsed.payload.revisions.length,documentCount:docIds.length,
   conflicts:docIds.filter(id=>grouped.get(id)!.length>1).length,
   pendingDeletions:docIds.filter(id=>grouped.get(id)!.some(r=>r.body.deleted)).length,
   preview:docIds.slice(0,100).map(id=>({docId:id,headCount:grouped.get(id)!.length,heads:grouped.get(id)!.slice(0,10).map(r=>({id:r.id,title:r.body.title,deleted:r.body.deleted}))})),
   truncated:docIds.length>100};throw rollback;
 }).immediate();}catch(error){if(error!==rollback)throw error;}
 return summary!;
}
export async function importExchange(spaceId:string,raw:string,actorId:string,authorize?:ExchangeAuthority) {
 if(Buffer.byteLength(raw)>32*1024*1024)throw new Error("Bundle exceeds limit");
 const {db,engine,lineage}=binding(spaceId),parsed=JSON.parse(raw);if(parsed?.payload?.lineage!==lineage)throw new Error("Bundle lineage does not match selected space");
 // Keep incremental imports off unless the operator explicitly opts in.
 if(parsed?.payload?.format!=="octavo-exchange-v1" && !(incrementalExchangeEnabled()&&parsed?.payload?.format==="octavo-exchange-delta-v1"))throw new Error("Only full snapshot exchange is enabled in the application; incremental delta is not enabled");
 const projector=await import("./collab-projection");
 return db.transaction(()=>{authorize?.();captureExchange(spaceId);const imported=engine.importBundle(raw);return {...imported,...applyAvailable(spaceId,actorId,projector)};}).immediate();
}
export async function applyExchange(spaceId:string,actorId:string,authorize?:ExchangeAuthority) {
 const {db}=binding(spaceId),projector=await import("./collab-projection");
 return db.transaction(()=>{authorize?.();captureExchange(spaceId);return applyAvailable(spaceId,actorId,projector);}).immediate();
}
export async function resolveExchange(spaceId:string,docId:string,selectedRevision:string,expectedHeads:string[],actorId:string,authorize?:ExchangeAuthority) {
 const {db,engine,lineage}=binding(spaceId),projector=await import("./collab-projection");
 return db.transaction(()=>{
  authorize?.();captureExchange(spaceId);
  const selected=engine.revisions(lineage,docId).find(r=>r.id===selectedRevision);if(!selected)throw new Error("Selected revision unavailable");
  const old=engine.applied(lineage,docId);const resolved=engine.resolve(lineage,docId,selected.body,expectedHeads);engine.setApplied(lineage,docId,old);
  return {resolved,...applyAvailable(spaceId,actorId,projector)};
 }).immediate();
}
type ExchangePageOptions={after?:string;limit?:number;docId?:string;historyAfter?:string;historyLimit?:number};
const revisionPreview=(r:ReturnType<SiteExchange["revisions"]>[number])=>({...r,body:{...r.body,content:r.body.content.slice(0,8192)},previewTruncated:r.body.content.length>8192});
export function readExchangeRevision(spaceId:string,docId:string,revisionId:string) {
 const {engine,lineage}=binding(spaceId);
 if(!docId||docId.length>128||!/^[a-f0-9]{64}$/.test(revisionId))throw new Error("Invalid revision selection");
 const revision=engine.revisions(lineage,docId).find(r=>r.id===revisionId);
 if(!revision)throw new Error("Revision unavailable in selected document and lineage");
 return {...revision,previewTruncated:false};
}
export function exchangeStatus(spaceId?:string,options:ExchangePageOptions={}) {
 const {db,engine,identity}=exchangeEngine();
 const bindings=db.prepare("SELECT * FROM site_exchange_bindings").all() as {space_id:string;lineage:string}[];
 const selected=spaceId?binding(spaceId):null;
 const limit=options.limit??100,historyLimit=options.historyLimit??20;
 if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(historyLimit)||historyLimit<1||historyLimit>20)throw new Error("Invalid page size");
 for(const v of [options.after,options.docId,options.historyAfter])if(v!==undefined&&(!v||v.length>128))throw new Error("Invalid cursor");
 if(options.historyAfter&&!options.docId)throw new Error("History cursor requires a document");
 const allIds=selected?[...new Set(engine.revisions(selected.lineage).map(r=>r.docId))].sort():[];
 const eligible=options.docId?allIds.filter(id=>id===options.docId):allIds.filter(id=>!options.after||id>options.after);
 const ids=eligible.slice(0,limit);
 const documents=selected?ids.map(docId=>{
  const revisions=engine.revisions(selected.lineage,docId).sort((a,b)=>a.id.localeCompare(b.id));
  const history=revisions.filter(r=>!options.historyAfter||r.id>options.historyAfter).slice(0,historyLimit);
  const last=history.at(-1)?.id;
  return {docId,history:history.map(revisionPreview),historyCount:revisions.length,historyNextCursor:last&&revisions.some(r=>r.id>last)?last:null,heads:engine.heads(selected.lineage,docId).map(revisionPreview),hold:(db.prepare("SELECT reason FROM site_exchange_holds WHERE lineage=? AND doc_id=?").get(selected.lineage,docId) as {reason:string}|undefined)?.reason??null,applied:engine.applied(selected.lineage,docId),mapping:db.prepare("SELECT page_id,hold FROM site_exchange_pages WHERE lineage=? AND doc_id=?").get(selected.lineage,docId)??null};
 }):[];
 const peers=selected?db.prepare("SELECT site,public_key FROM exchange_trust WHERE lineage=?").all(selected.lineage):[];
 return {stagingEnabled:stagingExchangeEnabled(),incrementalEnabled:incrementalExchangeEnabled(),identity:{siteId:identity.siteId,publicKey:identity.publicKey},bindings,documents,peers,documentCount:allIds.length,nextDocumentCursor:eligible.length>ids.length?ids.at(-1)??null:null};
}

/** Explicit exact-head acceptance creates a verified full-object archive first. */
export async function acceptExchangeDeletion(spaceId:string,docId:string,expectedHeads:string[],authorize?:ExchangeAuthority) {
 const {db,engine,lineage}=binding(spaceId),projector=await import("./collab-projection");
 return db.transaction(()=>{
  authorize?.();captureExchange(spaceId);
  const heads=engine.heads(lineage,docId);
  if(canonical(heads.map(h=>h.id).sort())!==canonical([...expectedHeads].sort()))throw new Error("Conflict heads changed");
  if(heads.length!==1||!heads[0].body.deleted)throw new Error("Select a single resolved deletion before archival");
  const mapping=db.prepare("SELECT * FROM site_exchange_pages WHERE lineage=? AND doc_id=?").get(lineage,docId) as Mapping|undefined;
  if(!mapping)throw new Error("Local page mapping unavailable");
  if(hasPageArchive(mapping.page_id)){
   const verified=verifyPageArchive(mapping.page_id,spaceId);
   engine.setApplied(lineage,docId,heads[0].id);
   db.prepare("DELETE FROM site_exchange_holds WHERE lineage=? AND doc_id=?").run(lineage,docId);
   db.prepare("UPDATE site_exchange_pages SET hold=NULL WHERE lineage=? AND doc_id=?").run(lineage,docId);
   return {...verified,replayed:true};
  }
  const page=getPage(mapping.page_id);if(!page||page.space_id!==spaceId)throw new Error("Local archive page unavailable");
  if(db.prepare("SELECT 1 FROM collab_room_leases WHERE page_id=? AND expires_at>?").get(page.id,Date.now()))throw new Error("Active editor must close and synchronize first");
  const shared=db.prepare("SELECT state FROM collab_docs WHERE page_id=?").get(page.id) as {state:Buffer}|undefined;
  if(shared&&(!shared.state.length||semantic(projector.projectSharedState(shared.state))!==semantic(projector.projectSharedState(projector.seedSharedState(page.content)))))throw new Error("Shared document diverges from saved page; recover first");
  const result=archivePage(page.id,spaceId);engine.setApplied(lineage,docId,heads[0].id);
  db.prepare("DELETE FROM site_exchange_holds WHERE lineage=? AND doc_id=?").run(lineage,docId);
  db.prepare("UPDATE site_exchange_pages SET hold=NULL WHERE lineage=? AND doc_id=?").run(lineage,docId);
  return result;
 }).immediate();
}
