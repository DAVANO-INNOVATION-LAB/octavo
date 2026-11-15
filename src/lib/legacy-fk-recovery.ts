import type Database from 'better-sqlite3';
import {archiveSchemaSignature} from './site-exchange-archive-schema';
import reviewedStore from './legacy-fk-recovery-reviewed.json';
import reviewed from './site-exchange-archive-reviewed.json';
import {createHash} from 'node:crypto';
const table='site_exchange_legacy_fk_recovery';
const targets={collab_docs:{parent:'pages',column:'page_id',keys:['page_id'],columns:['page_id','state','updated_at']},notifications:{parent:'users',column:'user_id',keys:['id'],columns:['id','user_id','kind','actor_name','title','body','url','space_id','created_at','read_at']},sync_state:{parent:'spaces',column:'space_id',keys:['space_id','path'],columns:['space_id','path','page_id','hash','synced_at']}};
export type LegacyRecoveryTarget=keyof typeof targets;
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const encode=(v:unknown)=>JSON.stringify(v);
function decode(v:string){return JSON.parse(v,(_key,value)=>value?.type==='Buffer'&&Array.isArray(value.data)&&Object.keys(value).length===2?Buffer.from(value.data):value);}
function ensure(db:Database.Database){
 db.exec(`CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY,source_table TEXT NOT NULL,row_json TEXT NOT NULL,checksum TEXT NOT NULL,recorded_at INTEGER NOT NULL,restored_at INTEGER)`);
 const storeSignature=archiveSchemaSignature(db,[table]).find(t=>t.name===table&&t.type==='table');
 if(JSON.stringify(storeSignature)!==JSON.stringify(reviewedStore))throw new Error('Unreviewed recovery store definition');
 for(const object of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[])if((db.pragma(`foreign_key_list("${object.name.replaceAll('"','""')}")`) as {table:string}[]).some(f=>f.table===table))throw new Error('Unreviewed inbound recovery dependency');
 const columns=db.pragma(`table_info(${table})`) as {name:string;type:string;notnull:number;dflt_value:unknown;pk:number}[];
 const expected=[['id','TEXT',0,1],['source_table','TEXT',1,0],['row_json','TEXT',1,0],['checksum','TEXT',1,0],['recorded_at','INTEGER',1,0],['restored_at','INTEGER',0,0]];
 if(JSON.stringify(columns.map(c=>[c.name,c.type,c.notnull,c.pk]))!==JSON.stringify(expected)||columns.some(c=>c.dflt_value!==null)||(db.pragma(`foreign_key_list(${table})`) as unknown[]).length||db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND tbl_name=?").get(table))throw new Error('Unreviewed recovery store schema');
}
function validate(name:LegacyRecoveryTarget,row:Record<string,unknown>){
 for(const value of Object.values(row))if(typeof value==='number'&&(!Number.isFinite(value)||(Number.isInteger(value)&&!Number.isSafeInteger(value))))throw new Error('Unsafe numeric recovery value; retention held');
 const target=targets[name];if(!target||Object.keys(row).sort().join(',')!==[...target.columns].sort().join(','))throw new Error('Unexpected legacy recovery row shape');
 for(const key of [...target.keys,target.column])if(typeof row[key]!=='string')throw new Error('Invalid recovery identity');
 return target;
}
/** Called only inside the ownership migration's immediate transaction. Retains
 * bytes before the table swap; never directly deletes or mutates source rows. */
export function retainLegacyOrphan(db:Database.Database,name:LegacyRecoveryTarget,row:Record<string,unknown>){
 if(!db.inTransaction)throw new Error('Recovery retention requires transaction');ensure(db);validate(name,row);
 const payload=encode(row);if(Buffer.byteLength(payload)>32*1024*1024)throw new Error('Recovery row exceeds limit; migration held');
 const checksum=hash(payload),id=hash(name+'\n'+payload);
 db.prepare(`INSERT INTO ${table}(id,source_table,row_json,checksum,recorded_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).run(id,name,payload,checksum,Date.now());
 const saved=db.prepare(`SELECT source_table,row_json,checksum FROM ${table} WHERE id=?`).get(id) as {source_table:string;row_json:string;checksum:string};
 if(saved.source_table!==name||saved.row_json!==payload||saved.checksum!==checksum||hash(saved.row_json)!==saved.checksum||encode(decode(saved.row_json))!==payload)throw new Error('Recovery copy verification failed');
 return id;
}
/** Local operator-only function. No route exposes recovery payloads or grants
 * access. Original missing parent must be recovered separately first. */
export function restoreLegacyOrphan(db:Database.Database,id:string){
 if(db.inTransaction)throw new Error('Recovery restore requires its own transaction');
 if(db.pragma('foreign_keys',{simple:true})!==1)throw new Error('Recovery restore requires foreign keys');
 return db.transaction(()=>{
  ensure(db);const saved=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as {id:string;source_table:LegacyRecoveryTarget;row_json:string;checksum:string;restored_at:number|null}|undefined;
  if(!saved||hash(saved.row_json)!==saved.checksum||hash(saved.source_table+'\n'+saved.row_json)!==saved.id)throw new Error('Recovery checksum or identity mismatch');
  const row=decode(saved.row_json) as Record<string,unknown>,target=validate(saved.source_table,row);
  if(!db.prepare(`SELECT 1 FROM ${target.parent} WHERE id=?`).get(row[target.column]))throw new Error('Original recovery parent is still missing');
  const fks=db.pragma(`foreign_key_list(${saved.source_table})`) as {table:string;from:string;to:string;on_delete:string}[];
  if(fks.length!==1||fks[0].table!==target.parent||fks[0].from!==target.column||fks[0].to!=='id'||fks[0].on_delete!=='CASCADE')throw new Error('Recovery target foreign key is unreviewed');
  for(const object of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[])if((db.pragma(`foreign_key_list("${object.name.replaceAll('"','""')}")`) as {table:string}[]).some(f=>f.table===saved.source_table))throw new Error('Unreviewed inbound target dependency');
  const actualSchema=archiveSchemaSignature(db).find(t=>t.name===saved.source_table&&t.type==='table'),expectedSchema=reviewed.find(t=>t.name===saved.source_table&&t.type==='table');
  if(JSON.stringify(actualSchema)!==JSON.stringify(expectedSchema)||db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND tbl_name=?").get(saved.source_table))throw new Error('Recovery target schema or triggers changed');
  const columns=(db.pragma(`table_info(${saved.source_table})`) as {name:string}[]).map(c=>c.name);
  if([...columns].sort().join(',')!==[...target.columns].sort().join(','))throw new Error('Recovery target columns changed');
  const existing=db.prepare(`SELECT ${target.columns.join(',')} FROM ${saved.source_table} WHERE ${target.keys.map(k=>k+'=?').join(' AND ')}`).get(...target.keys.map(k=>row[k]));
  if(existing){if(saved.restored_at!==null&&encode(existing)===encode(Object.fromEntries(target.columns.map(k=>[k,row[k]]))))return {id,restored:true,replayed:true};throw new Error('Recovery target identity collision');}
  db.prepare(`INSERT INTO ${saved.source_table} (${target.columns.join(',')}) VALUES (${target.columns.map(()=>'?').join(',')})`).run(...target.columns.map(k=>row[k]));
  const restored=db.prepare(`SELECT ${target.columns.join(',')} FROM ${saved.source_table} WHERE ${target.keys.map(k=>k+'=?').join(' AND ')}`).get(...target.keys.map(k=>row[k]));
  if(encode(restored)!==encode(Object.fromEntries(target.columns.map(k=>[k,row[k]]))))throw new Error('Recovery restored-row verification failed');
  if((db.pragma('foreign_key_check') as unknown[]).length)throw new Error('Recovery dependency verification failed');
  db.prepare(`UPDATE ${table} SET restored_at=? WHERE id=?`).run(Date.now(),id);
  return {id,restored:true,replayed:false};
 }).immediate();
}
