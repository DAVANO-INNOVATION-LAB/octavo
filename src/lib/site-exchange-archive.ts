import "server-only";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getDb, UPLOADS_DIR } from "./db";
import { fileNamesIn } from "./uploads";
import { archiveSchemaSignature } from "./site-exchange-archive-schema";
import reviewedSchema from "./site-exchange-archive-reviewed.json";

// Deliberately reviewed schema, not an optimistic walk of arbitrary future tables.
// Unknown schema changes hold deletion until their ownership semantics are reviewed.
const SCHEMA = createHash("sha256").update(JSON.stringify(reviewedSchema)).digest("hex");
const digest=(v:string|Buffer)=>createHash("sha256").update(v).digest("hex");
const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
type Row=Record<string,unknown>;
type Archive={schema:string;spaceId:string;tenant:string|null;pageId:string;rows:Record<string,Row[]>;files:Record<string,{bytes:string;hash:string;origin:Row;references:Row[]}>};
const encode=(value:unknown)=>JSON.stringify(value,(_key,v)=>v?.type==='Buffer'&&Array.isArray(v.data)?{archiveBuffer:Buffer.from(v.data).toString('base64')}:v);
const decode=(value:string)=>JSON.parse(value,(_key,v)=>v&&typeof v==='object'&&Object.keys(v).length===1&&typeof v.archiveBuffer==='string'?Buffer.from(v.archiveBuffer,'base64'):v);
function schema(){if(digest(JSON.stringify(archiveSchemaSignature(getDb())))!==SCHEMA)throw new Error("Archival schema differs from reviewed schema; deletion held");}
function table(){getDb().exec(`CREATE TABLE IF NOT EXISTS site_exchange_archives(page_id TEXT PRIMARY KEY,space_id TEXT NOT NULL,tenant_id TEXT,payload TEXT NOT NULL,checksum TEXT NOT NULL,restored INTEGER NOT NULL DEFAULT 0)`);}
/** No foreign key to pages/spaces: ordinary deletion cannot cascade the recovery copy. */
export function hasPageArchive(pageId:string){table();return !!getDb().prepare("SELECT 1 FROM site_exchange_archives WHERE page_id=? AND restored=0").get(pageId);}
/** Re-acknowledgment must verify the retained recovery copy, not merely a row's existence. */
export function verifyPageArchive(pageId:string,spaceId:string){
 const db=getDb();if(!db.inTransaction)throw new Error('Archive verification requires transaction');schema();table();
 const stored=db.prepare('SELECT space_id,tenant_id,payload,checksum FROM site_exchange_archives WHERE page_id=? AND restored=0').get(pageId) as {space_id:string;tenant_id:string|null;payload:string;checksum:string}|undefined;
 if(!stored||digest(stored.payload)!==stored.checksum)throw new Error('Verified page archive unavailable');
 let a:Archive;try{a=decode(stored.payload) as Archive;}catch{throw new Error('Verified page archive unavailable');}
 const space=db.prepare('SELECT tenant_id FROM spaces WHERE id=? AND id NOT IN (SELECT space_id FROM deleted_spaces)').get(spaceId) as {tenant_id:string|null}|undefined;
 if(!a||a.schema!==SCHEMA||a.pageId!==pageId||a.spaceId!==spaceId||stored.space_id!==spaceId||!space||a.tenant!==space.tenant_id||stored.tenant_id!==a.tenant)throw new Error('Archive source tenant or space changed');
 if(db.prepare('SELECT 1 FROM pages WHERE id=?').get(pageId))throw new Error('Archive UUID collision');
 if(!Array.isArray(a.rows?.pages)||a.rows.pages.length!==1||a.rows.pages[0].id!==pageId||a.rows.pages[0].space_id!==spaceId||encode(a)!==stored.payload)throw new Error('Archive page identity verification failed');
 for(const [name,file] of Object.entries(a.files??{}))if(!/^[a-z0-9]+\.[a-z0-9]+$/.test(name)||!file||typeof file.bytes!=='string'||digest(Buffer.from(file.bytes,'base64'))!==file.hash||file.origin?.name!==name||file.origin?.space_id!==spaceId)throw new Error('Archive attachment verification failed');
 return {archived:true,pageId};
}
export function archivePage(pageId:string,spaceId:string){
 const db=getDb();if(!db.inTransaction)throw new Error("Archival requires transaction");schema();table();
 const page=db.prepare('SELECT * FROM pages WHERE id=? AND space_id=?').get(pageId,spaceId) as Row|undefined;
 if(!page)throw new Error('Archive page unavailable');
 if(db.prepare('SELECT 1 FROM pages WHERE parent_id=?').get(pageId))throw new Error('Archive children individually first');
 for(const name of ['repo_state','repo_sync_baselines','sync_state'])if(db.prepare(`SELECT 1 FROM ${name} WHERE page_id=?`).get(pageId))throw new Error('Repository or directory synchronization mapping requires migration before archival');
 if(db.prepare('SELECT 1 FROM site_exchange_archives WHERE page_id=? AND restored=0').get(pageId))throw new Error('Archive already exists');
 const tenant=(db.prepare('SELECT tenant_id FROM spaces WHERE id=?').get(spaceId) as {tenant_id:string|null}).tenant_id;
 const rows:Record<string,Row[]>={pages:[page]};
 const names=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('pages_fts','pages_fts_data','pages_fts_idx','pages_fts_content','pages_fts_docsize','pages_fts_config','exchange_scopes','exchange_trust','exchange_revisions','exchange_applied','exchange_assets','exchange_receipts','site_exchange_pages','site_exchange_bindings','site_exchange_holds','site_exchange_archives')").all() as {name:string}[]).map(r=>r.name);
 // All cascading descendants, including reviews of change requests and runbook evidence.
 for(let pass=0;pass<names.length;pass++){
  let changed=false;
  for(const name of names){if(name==='pages')continue;
   for(const fk of db.pragma(`foreign_key_list(${quote(name)})`) as {table:string;from:string;to:string;on_delete:string;seq:number}[]){
    if(!rows[fk.table]?.length)continue;
    if(fk.seq!==0||fk.on_delete!=='CASCADE')throw new Error('Unsupported dependent foreign key; archival held');
    for(const parent of rows[fk.table]){
     const found=db.prepare(`SELECT * FROM ${quote(name)} WHERE ${quote(fk.from)}=?`).all(parent[fk.to]) as Row[];
     for(const row of found){const dest=rows[name]??=[];if(!dest.some(x=>encode(x)===encode(row))){dest.push(row);changed=true;}}
    }
   }
  }
  if(!changed)break;
 }
 rows.collab_recovery_updates=db.prepare('SELECT * FROM collab_recovery_updates WHERE page_id=?').all(pageId) as Row[];
 for(const group of Object.values(rows))for(const row of group)for(const value of Object.values(row))if(typeof value==='number'&&(!Number.isFinite(value)||(Number.isInteger(value)&&!Number.isSafeInteger(value))))throw new Error('Unsafe numeric archive value; archival held');
 const files:Archive['files']={};
 for(const group of Object.values(rows))for(const row of group)for(const value of Object.values(row))if(typeof value==='string')for(const name of fileNamesIn(value)){
  if(!/^[a-z0-9]+\.[a-z0-9]+$/.test(name))throw new Error('Unsupported archive attachment');
  const filename=path.join(UPLOADS_DIR,name),stat=fs.lstatSync(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024)throw new Error('Archive attachment unavailable');
  const origin=db.prepare('SELECT * FROM uploads WHERE name=?').get(name) as Row|undefined;if(!origin||origin.space_id!==spaceId)throw new Error('Archive attachment provenance unavailable');
  const references=db.prepare('SELECT * FROM upload_refs WHERE name=? AND space_id=?').all(name,spaceId) as Row[];
  const bytes=fs.readFileSync(filename);files[name]={bytes:bytes.toString('base64'),hash:digest(bytes),origin,references};
 }
 const archive:Archive={schema:SCHEMA,spaceId,tenant,pageId,rows,files},payload=encode(archive),checksum=digest(payload);
 if(Buffer.byteLength(payload)>32*1024*1024)throw new Error('Full-object archive exceeds 32 MiB; deletion held');
 db.prepare('INSERT INTO site_exchange_archives VALUES(?,?,?,?,?,0) ON CONFLICT(page_id) DO UPDATE SET space_id=excluded.space_id,tenant_id=excluded.tenant_id,payload=excluded.payload,checksum=excluded.checksum,restored=0').run(pageId,spaceId,tenant,payload,checksum);
 const stored=db.prepare('SELECT payload,checksum FROM site_exchange_archives WHERE page_id=?').get(pageId) as {payload:string;checksum:string};
 if(stored.payload!==payload||digest(stored.payload)!==stored.checksum||encode(decode(stored.payload))!==payload)throw new Error('Archive verification failed');
 // Recoverable removal only after equivalent durable transaction-local copy verified.
 db.prepare('DELETE FROM pages_fts WHERE page_id=?').run(pageId);
 db.prepare('DELETE FROM collab_recovery_updates WHERE page_id=?').run(pageId);
 db.prepare('DELETE FROM pages WHERE id=?').run(pageId);
 return {archived:true,pageId};
}
export function restorePageArchive(pageId:string,spaceId:string){
 const db=getDb();if(!db.inTransaction)throw new Error('Restore requires transaction');schema();table();
 const stored=db.prepare('SELECT payload,checksum FROM site_exchange_archives WHERE page_id=? AND restored=0').get(pageId) as {payload:string;checksum:string}|undefined;
 if(!stored||digest(stored.payload)!==stored.checksum)throw new Error('Verified page archive unavailable');
 const a=decode(stored.payload) as Archive,space=db.prepare('SELECT tenant_id FROM spaces WHERE id=? AND id NOT IN (SELECT space_id FROM deleted_spaces)').get(spaceId) as {tenant_id:string|null}|undefined;
 if(a.schema!==SCHEMA||a.pageId!==pageId||a.spaceId!==spaceId||!space||space.tenant_id!==a.tenant)throw new Error('Archive source tenant or space changed');
 if(db.prepare('SELECT 1 FROM pages WHERE id=?').get(pageId))throw new Error('Archive UUID collision');
 // File copies remain in the archive even after restore, and never overwrite existing bytes.
 for(const [name,file] of Object.entries(a.files)){
  const bytes=Buffer.from(file.bytes,'base64');if(digest(bytes)!==file.hash)throw new Error('Archive attachment checksum mismatch');
  const origin=db.prepare('SELECT * FROM uploads WHERE name=?').get(name);if(origin&&encode(origin)!==encode(file.origin))throw new Error('Archive attachment provenance collision');
  if(!origin){const keys=Object.keys(file.origin);db.prepare(`INSERT INTO uploads (${keys.map(quote).join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>file.origin[k]));}
  for(const ref of file.references)db.prepare('INSERT OR IGNORE INTO upload_refs(name,space_id) VALUES(?,?)').run(ref.name,ref.space_id);
  const filename=path.join(UPLOADS_DIR,name);
  if(fs.existsSync(filename)){const stat=fs.lstatSync(filename);if(!stat.isFile()||stat.isSymbolicLink()||digest(fs.readFileSync(filename))!==file.hash)throw new Error('Archive attachment collision');}
  else fs.writeFileSync(filename,bytes,{mode:0o600,flag:'wx'});
 }
 db.exec('PRAGMA defer_foreign_keys=ON');
 for(const [name,group] of Object.entries(a.rows))for(const row of group){
  // Page insert creates the edit-version row; replace only that fresh derived stub.
  if(name==='page_edit_versions')db.prepare('DELETE FROM page_edit_versions WHERE page_id=?').run(pageId);
  const keys=Object.keys(row);db.prepare(`INSERT INTO ${quote(name)} (${keys.map(quote).join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));
 }
 if((db.pragma('foreign_key_check') as unknown[]).length)throw new Error('Archive dependencies changed; restore held');
 for(const [name,group] of Object.entries(a.rows))for(const row of group){const pk=(db.pragma(`table_info(${quote(name)})`) as {name:string;pk:number}[]).filter(c=>c.pk).sort((x,y)=>x.pk-y.pk);if(!pk.length)throw new Error('Archive table lacks identity');const found=db.prepare(`SELECT * FROM ${quote(name)} WHERE ${pk.map(c=>quote(c.name)+'=?').join(' AND ')}`).get(...pk.map(c=>row[c.name]));if(encode(found)!==encode(row))throw new Error('Restored row verification failed');}
 db.prepare('UPDATE site_exchange_archives SET restored=1 WHERE page_id=?').run(pageId);
 return {restored:true,pageId};
}
