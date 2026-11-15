import type Database from 'better-sqlite3';
const ignored=new Set(['pages_fts_data','pages_fts_idx','pages_fts_content','pages_fts_docsize','pages_fts_config','exchange_scopes','exchange_trust','exchange_revisions','exchange_applied','exchange_assets','exchange_receipts','site_exchange_pages','site_exchange_bindings','site_exchange_holds','site_exchange_link_aliases','site_exchange_archives','site_exchange_legacy_fk_recovery']);
const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
/** SQL token normalization preserves quoted literals, predicates and expressions,
 * while removing formatting/comments changed by bundlers and ALTER rendering. */
function tokens(sql:string){return (sql.match(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[(?:[^\]])*\]|[a-zA-Z_][\w$]*|\d+(?:\.\d+)?|<>|!=|<=|>=|\|\||[^\s]/g)??[]).filter(x=>!x.startsWith('--')&&!x.startsWith('/*')).map(x=>x.startsWith("'")||x.startsWith('"')||x.startsWith('`')||x.startsWith('[')?x:x.toLowerCase());}
export function normalized(sql:string|null){return sql===null?null:tokens(sql).join(' ');}
function checks(sql:string){const t=tokens(sql),out:string[]=[];for(let i=0;i<t.length;i++)if(t[i]==='check'&&t[i+1]==='('){let depth=0,j=i+1;for(;j<t.length;j++){if(t[j]==='(')depth++;if(t[j]===')'&&--depth===0)break;}out.push(t.slice(i,j+1).join(' '));i=j;}return out.sort();}
// Preserve each complete column/constraint declaration, but canonicalize their
// top-level order. Composite key/expression token order is never changed.
function definition(sql:string,name:string){
 const t=tokens(sql),open=t.indexOf('(');if(open<0||t.includes('virtual'))return normalized(sql);
 const declarations:string[][]=[];let depth=1,start=open+1,end=start;
 for(;end<t.length;end++){if(t[end]==='(')depth++;if(t[end]===')')depth--;if(depth===0){declarations.push(t.slice(start,end));break;}if(depth===1&&t[end]===','){declarations.push(t.slice(start,end));start=end+1;}}
 if(depth!==0)throw new Error('Unrecognized table declaration');
 if(t.some((token,i)=>token==='on'&&t[i+1]==='conflict'))return `create table ${name} ( ${declarations.map(d=>d.join(' ')).join(' , ')} )${t.slice(end+1).length?' '+t.slice(end+1).join(' '):''}`;
 const constraint=(d:string[])=>['constraint','primary','unique','check','foreign'].includes(d[0]);
 const cols=declarations.filter(d=>!constraint(d)).map(d=>d.join(' ')).sort(),constraints=declarations.filter(constraint).map(d=>d.join(' ')).sort();
 return `create table ${name} ( ${[...cols,...constraints].join(' , ')} )${t.slice(end+1).length?' '+t.slice(end+1).join(' '):''}`;
}
const stable=(value:unknown)=>JSON.stringify(value);
export function archiveSchemaSignature(db:Database.Database,includeRetained:string[]=[]){
 const objects=db.prepare("SELECT name,type,sql FROM sqlite_master WHERE type IN ('table','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name,type").all() as {name:string;type:string;sql:string}[];
 for(const o of objects)if(o.type==='table'&&ignored.has(o.name)&&!o.name.startsWith('pages_fts_')&&(db.pragma(`foreign_key_list(${quote(o.name)})`) as unknown[]).length)throw new Error('Unexpected protocol foreign key; archival schema review required');
 return objects.filter(o=>o.type==='trigger'||!ignored.has(o.name)||includeRetained.includes(o.name)).map(o=>{
  if(o.type==='trigger')return {name:o.name,type:o.type,sql:normalized(o.sql)};
  const metadata=(db.pragma('table_list') as {name:string;strict:number;wr:number}[]).find(t=>t.name===o.name);
  const columns=(db.pragma(`table_xinfo(${quote(o.name)})`) as {cid:number;name:string;type:string;notnull:number;dflt_value:string|null;pk:number;hidden:number}[]).map(c=>({name:c.name,type:c.type.toUpperCase(),notnull:c.notnull,default:normalized(c.dflt_value),pk:c.pk,hidden:c.hidden})).sort((a,b)=>a.name.localeCompare(b.name));
  const groups=new Map<number,{seq:number;table:string;from:string;to:string;on_update:string;on_delete:string;match:string}[]>();
  for(const f of db.pragma(`foreign_key_list(${quote(o.name)})`) as {id:number;seq:number;table:string;from:string;to:string;on_update:string;on_delete:string;match:string}[]){const {id,...rest}=f;const values=groups.get(id)??[];values.push(rest);groups.set(id,values);}
  const foreign=[...groups.values()].map(g=>g.sort((a,b)=>a.seq-b.seq)).sort((a,b)=>stable(a).localeCompare(stable(b)));
  const indexes=(db.pragma(`index_list(${quote(o.name)})`) as {name:string;unique:number;origin:string;partial:number}[]).map(i=>({name:i.origin==='c'?i.name:null,unique:i.unique,origin:i.origin,partial:i.partial,sql:i.origin==='c'?normalized((db.prepare('SELECT sql FROM sqlite_master WHERE type=\'index\' AND name=?').get(i.name) as {sql:string}).sql):null,columns:(db.pragma(`index_xinfo(${quote(i.name)})`) as {seqno:number;cid:number;name:string|null;desc:number;coll:string;key:number}[]).map(({cid,...c})=>c)})).sort((a,b)=>stable(a).localeCompare(stable(b)));
  return {name:o.name,type:o.type,definition:definition(o.sql,o.name),strict:metadata?.strict??0,withoutRowid:metadata?.wr??0,columns,foreign,indexes,checks:checks(o.sql),virtual:o.sql.toLowerCase().startsWith('create virtual')?normalized(o.sql):null};
 });
}
