// Isolated real SQLite coverage for search synchronization and derived-index repair.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, {createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),root=path.resolve('src');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-search-index-'));
process.env.OCTAVO_DATA_DIR=temporary;
const oldLoad=Module._load,oldTs=Module._extensions['.ts'];
let db,checks=0;
Module._load=function(name,parent,main){
  if(name==='server-only')return {};
  if(name==='next/headers')return {cookies:async()=>({get:()=>undefined})};
  if(name.startsWith('@/'))name=path.join(root,name.slice(2));
  return oldLoad.call(this,name,parent,main);
};
Module._extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const load=name=>require(path.join(root,name));
const content=text=>JSON.stringify([{id:'paragraph',type:'paragraph',content:[{type:'text',text,styles:{}}],children:[]}]);
const check=(actual,expected,message)=>{assert.deepEqual(actual,expected,message);checks++;};
try {
  const database=load('lib/db.ts');db=database.getDb();
  const data=load('lib/data.ts'),index=load('lib/search-index.ts');
  const space=data.createSpace({name:'Synthetic indexed space',visibility:'public'});
  db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run('synthetic-owner','owner@example.test','Synthetic Owner','!','member',1);
  load('lib/roles.ts').setSpaceMember(space.id,'synthetic-owner','admin');
  const fts=id=>db.prepare('SELECT page_id,title,body FROM pages_fts WHERE page_id=?').all(id);
  const expected=page=>page.published===1?[{page_id:page.id,title:page.title,body:page.content_text}]:[];
  const assertIndex=page=>check(fts(page.id),expected(page),'FTS matches actual publication/title/body');
  const snapshot=()=>JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}"`).all()]));
  const source=()=>JSON.stringify(['pages','spaces','page_versions','space_members'].map(name=>[name,db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  const failPrepare=(match,operation)=>{
    const prepare=db.prepare;
    db.prepare=function(sql){if(match(sql))throw Error('synthetic index failure');return prepare.call(this,sql);};
    try{assert.throws(operation,/synthetic index failure/);checks++;}finally{db.prepare=prepare;}
  };
  let published=data.createPage({spaceId:space.id,title:'Published original',content:content('searchable original'),published:true});assertIndex(published);
  let draft=data.createPage({spaceId:space.id,title:'Draft original',content:content('draft original')});assertIndex(draft);
  published=data.savePage(published.id,{title:'Published renamed'});assertIndex(published);
  published=data.savePage(published.id,{content:content('replacement body')});assertIndex(published);
  for(let i=0;i<3;i++)published=data.savePage(published.id,{});assertIndex(published);
  draft=data.savePage(draft.id,{published:true});assertIndex(draft);
  draft=data.savePage(draft.id,{published:false});assertIndex(draft);
  draft=data.savePage(draft.id,{title:'Edited draft',content:content('edited draft body')});assertIndex(draft);
  const policySpace=data.createSpace({name:'Governed synthetic',visibility:'public'});
  let governed=data.createPage({spaceId:policySpace.id,title:'Governed page',content:content('governed body'),published:true});assertIndex(governed);
  db.prepare('INSERT INTO quality_policies(space_id,policy) VALUES(?,?)').run(policySpace.id,JSON.stringify({required:['Required section'],review:false,approval:false,links:false}));
  const forcedDraft=data.createPage({spaceId:policySpace.id,title:'Import requested published',content:content('not approved'),published:true});check(forcedDraft.published,0,'policy prevents import publication');assertIndex(forcedDraft);
  governed=data.savePage(governed.id,{content:content('governed edited')});check(governed.published,0,'governed published edit becomes draft');assertIndex(governed);
  for(const operation of [()=>data.createPage({spaceId:space.id,title:'Rollback create',content:content('rollback'),published:true}),()=>data.savePage(published.id,{title:'Rollback rename',content:content('rollback body')})]){
    const before=snapshot();failPrepare(sql=>/INSERT\s+INTO\s+pages_fts/i.test(sql),operation);check(snapshot(),before,'index failure rolls back page, versions, links and timestamps');
  }
  const beforeOuter=snapshot();assert.throws(()=>db.transaction(()=>{data.createPage({spaceId:space.id,title:'Nested rollback',published:true});throw Error('outer rollback');})(),/outer rollback/);check(snapshot(),beforeOuter,'nested transaction rollback includes index');
  assert.throws(()=>index.syncPageSearchIndex(db,published),/transaction/);checks++;
  const missing=data.createPage({spaceId:space.id,title:'Missing imported row',content:content('missing body'),published:true});
  db.prepare('DELETE FROM pages_fts WHERE page_id=?').run(missing.id);
  db.prepare('UPDATE pages_fts SET title=?,body=? WHERE page_id=?').run('Stale title','stale body',published.id);
  const insert=db.prepare('INSERT INTO pages_fts(page_id,title,body) VALUES(?,?,?)');
  insert.run(published.id,'Duplicate','duplicate body');insert.run('orphan-page','Orphan','orphan body');insert.run(draft.id,'Draft stale','draft leak');
  db.prepare('DELETE FROM kv WHERE key=?').run(index.SEARCH_INDEX_REPAIR_KEY);
  const legacy=snapshot(),sourceBefore=source();
  const exec=db.exec;
  db.exec=function(sql){if(/INSERT\s+INTO\s+pages_fts/i.test(sql))throw Error('synthetic rebuild failure');return exec.call(this,sql);};
  try{assert.throws(()=>index.repairPageSearchIndex(db),/synthetic rebuild failure/);checks++;}finally{db.exec=exec;}
  check(snapshot(),legacy,'failed rebuild rolls back deletion and leaves marker absent');
  failPrepare(sql=>/INSERT\s+INTO\s+kv/i.test(sql),()=>index.repairPageSearchIndex(db));
  check(snapshot(),legacy,'failed completion marker rolls back full rebuild');
  check(index.repairPageSearchIndex(db),true,'legacy repair runs');
  check(source(),sourceBefore,'repair preserves content, timestamps, versions, spaces and grants');
  const allIndexed=()=>db.prepare('SELECT page_id,title,body FROM pages_fts ORDER BY page_id').all();
  const allExpected=db.prepare('SELECT id AS page_id,title,content_text AS body FROM pages WHERE published=1 ORDER BY id').all();
  check(allIndexed(),allExpected,'repair removes duplicates, draft/orphan rows and repairs missing/stale entries');
  check(db.prepare('SELECT value FROM kv WHERE key=?').get(index.SEARCH_INDEX_REPAIR_KEY),{value:'complete'},'marker committed last');
  const repaired=snapshot();check(index.repairPageSearchIndex(db),false,'repair is one-time');check(snapshot(),repaired,'second repair does not mutate rows');
  db.close();delete globalThis.__octavoDb;db=database.getDb();
  check(snapshot(),repaired,'writable reopen is idempotent');
  db.prepare('DELETE FROM kv WHERE key=?').run(index.SEARCH_INDEX_REPAIR_KEY);
  db.prepare('DELETE FROM pages_fts WHERE page_id=?').run(missing.id);
  const beforeStartup=source();db.close();delete globalThis.__octavoDb;db=database.getDb();
  check(allIndexed(),allExpected,'writable startup performs legacy repair');
  check(source(),beforeStartup,'startup repair preserves source rows');
  db.transaction(()=>index.syncPageSearchIndex(db,published))();assertIndex(published);

  console.log(`${checks} search-index checks passed (isolated SQLite)`);
} finally {
  if(db?.open)db.close();delete globalThis.__octavoDb;
  Module._load=oldLoad;if(oldTs)Module._extensions['.ts']=oldTs;else delete Module._extensions['.ts'];
  fs.rmSync(temporary,{recursive:true,force:true});
}
