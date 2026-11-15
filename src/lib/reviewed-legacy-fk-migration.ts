import type Database from 'better-sqlite3';
import { archiveSchemaSignature, normalized } from './site-exchange-archive-schema';
import {retainLegacyOrphan,type LegacyRecoveryTarget} from './legacy-fk-recovery';
import reviewed from './site-exchange-archive-reviewed.json';
const targets=[{table:'collab_docs',column:'page_id',parent:'pages'},{table:'notifications',column:'user_id',parent:'users'},{table:'sync_state',column:'space_id',parent:'spaces'}];
const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
/** Reviewed historical schemas omitted these ownership FKs. No orphan is dropped
 * or reassigned: all three changes commit together or none does. */
export function migrateReviewedLegacyForeignKeys(db:Database.Database,options:{retainOrphans?:boolean}={}){
 if(db.inTransaction)throw new Error('Legacy FK migration requires its own transaction');
 if(db.pragma('foreign_keys',{simple:true})!==1)throw new Error('Enable foreign_keys before legacy migration');
 return db.transaction(()=>{
 const changes:typeof targets=[];
 const orphanRows=new Map<string,Record<string,unknown>[]>(),recoveryIds:string[]=[];
 const signature=archiveSchemaSignature(db);
 for(const target of targets){
  const current=signature.find(s=>s.name===target.table&&s.type==='table');
  const expected=reviewed.find(s=>s.name===target.table&&s.type==='table')!;
  if(!current)continue;
  const fks=db.pragma(`foreign_key_list(${quote(target.table)})`) as {seq:number;table:string;from:string;to:string;on_update:string;on_delete:string;match:string}[];
  if(fks.length===1&&fks[0].seq===0&&fks[0].table===target.parent&&fks[0].from===target.column&&fks[0].to==='id'&&fks[0].on_delete==='CASCADE'&&fks[0].on_update==='NO ACTION'&&fks[0].match==='NONE')continue;
  if(fks.length)throw new Error(`Unreviewed foreign key configuration on ${target.table}; migration held`);
  const oldDefinition=expected.definition!.replace(` references ${target.parent} ( id ) on delete cascade`,'');
  if(!('definition' in current)||current.definition!==oldDefinition)throw new Error(`Unreviewed legacy table definition ${target.table}; migration held`);
  changes.push(target);
 }
 if(!changes.length)return {migrated:[] as string[],retainedOrphans:0,recoveryIds:[] as string[]};
  const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[]);
  for(const target of changes){
   for(const table of tables)if((db.pragma(`foreign_key_list(${quote(table.name)})`) as {table:string}[]).some(f=>f.table===target.table))throw new Error(`Inbound foreign key to ${target.table}; migration held`);
   const orphans=db.prepare(`SELECT child.* FROM ${quote(target.table)} child LEFT JOIN ${quote(target.parent)} parent ON parent.id=child.${quote(target.column)} WHERE child.${quote(target.column)} IS NOT NULL AND parent.id IS NULL`).all() as Record<string,unknown>[];
   if(orphans.length&&!options.retainOrphans)throw new Error(`${target.table} has ${orphans.length} orphan reference(s); migration held without deleting rows`);
   orphanRows.set(target.table,orphans);
   for(const row of orphans)recoveryIds.push(retainLegacyOrphan(db,target.table as LegacyRecoveryTarget,row));
  }
  if((db.pragma('foreign_key_check') as unknown[]).length)throw new Error('Existing foreign key violations; migration held');
  for(const target of changes){
   const expected=reviewed.find(s=>s.name===target.table&&s.type==='table')!,temporary=`__octavo_reviewed_fk_${target.table}`;
   if(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(temporary))throw new Error('Legacy migration temporary-name collision');
   const objects=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name").all(target.table) as {type:string;name:string;sql:string}[];
   const columns=db.pragma(`table_info(${quote(target.table)})`) as {name:string;pk:number}[];
   const names=columns.map(c=>quote(c.name)).join(','),order=columns.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>quote(c.name)).join(',');
   if(!order)throw new Error('Legacy table lacks stable row identity');
   const allRows=db.prepare(`SELECT ${names} FROM ${quote(target.table)} ORDER BY ${order}`).all() as Record<string,unknown>[];
   for(const row of allRows)for(const value of Object.values(row))if(typeof value==='number'&&(!Number.isFinite(value)||(Number.isInteger(value)&&!Number.isSafeInteger(value))))throw new Error('Unsafe numeric migration value; migration held');
   const before=allRows.filter(row=>!(orphanRows.get(target.table)??[]).some(orphan=>JSON.stringify(orphan)===JSON.stringify(row)));
   // Preserve physical column order for legacy positional INSERT consumers.
   const original=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(target.table) as {sql:string};
   const declaration=normalized(original.sql)!;
   const anchor=target.table==='collab_docs'?'page_id text primary key':`${target.column} text not null`;
   const upgraded=declaration.slice(declaration.indexOf(' ( ')).replace(anchor,`${anchor} references ${target.parent} ( id ) on delete cascade`);
   db.exec(`CREATE TABLE ${quote(temporary)}${upgraded}`);
   db.exec(`INSERT INTO ${quote(temporary)} (${names}) SELECT ${names} FROM ${quote(target.table)} source WHERE source.${quote(target.column)} IS NULL OR EXISTS(SELECT 1 FROM ${quote(target.parent)} parent WHERE parent.id=source.${quote(target.column)})`);
   const copied=db.prepare(`SELECT ${names} FROM ${quote(temporary)} ORDER BY ${order}`).all();
   if(JSON.stringify(before)!==JSON.stringify(copied))throw new Error('Legacy migration row verification failed');
   db.exec(`DROP TABLE ${quote(target.table)}`);
   db.exec(`ALTER TABLE ${quote(temporary)} RENAME TO ${quote(target.table)}`);
   for(const object of objects)db.exec(object.sql);
   const after=db.prepare(`SELECT ${names} FROM ${quote(target.table)} ORDER BY ${order}`).all();
   if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Legacy migration post-swap verification failed');
   for(const object of objects){const restored=db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get(object.type,object.name) as {sql:string}|undefined;if(restored?.sql!==object.sql)throw new Error('Legacy migration index/trigger verification failed');}
  }
  if((db.pragma('foreign_key_check') as unknown[]).length)throw new Error('Legacy migration foreign key verification failed');
  if(db.pragma('integrity_check',{simple:true})!=='ok')throw new Error('Legacy migration integrity verification failed');
  return {migrated:changes.map(t=>t.table),retainedOrphans:recoveryIds.length,recoveryIds};
 }).immediate();
}
