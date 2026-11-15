// Actual repository orchestration + SQLite/data model; deterministic remote adapter.
// No external network, production data, credentials or live repositories.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import ts from 'typescript';
import {createServer} from 'node:http';
import * as BlockNoteCore from '@blocknote/core';
import * as BlockNoteYjs from '@blocknote/core/yjs';
import * as Yjs from 'yjs';
const require=createRequire(import.meta.url),root=path.resolve('src'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-repo-sync-'));
process.env.OCTAVO_DATA_DIR=dir;
process.env.OCTAVO_COLLAB="0";
const originalLoad=Module._load, originalTs=Module._extensions['.ts'];
let remote=new Map(), head='r1', afterRead, afterPush, failRead=false, failPush=false, checks=0;
const adapter={
 resolveRevision:async()=>({ok:true,value:head}),
 listMarkdown:async c=>{assert.equal(c.branch,head);return {ok:true,value:[...remote.keys()].map(path=>({path,sha:'blob'}))};},
 readFile:async(c,p)=>{assert.equal(c.branch,head);if(failRead)return {ok:false,error:'read failed'};const value=remote.get(p);if(afterRead){const fn=afterRead;afterRead=null;fn();}return {ok:true,value};},
 pushFiles:async(c,changes,message,expected)=>{assert.equal(expected,head);if(failPush)return {ok:false,error:'push rejected'};for(const x of changes)remote.set(x.path,x.content);head+='x';if(afterPush){const fn=afterPush;afterPush=null;fn();}return {ok:true,value:{commit:head,files:changes.length}};},
 verifyConnection:async()=>({ok:true,value:{branch:'main'}}),
};
Module._load=function(name,parent,main){
 if(name==='server-only')return {};
 if(name==='@blocknote/core')return BlockNoteCore;
 if(name==='@blocknote/core/yjs')return BlockNoteYjs;
 if(name==='yjs')return Yjs;
 if(name==='./git-host' && parent?.filename.endsWith('repo-sync.ts'))return adapter;
 if(name==='./audit-forward')return {forwardAudit:()=>{}};
 if(name==='next/headers')return {cookies:async()=>({get:()=>undefined}),headers:async()=>new Map()};
 if(name.startsWith('@/'))name=path.join(root,name.slice(2));
 return originalLoad.call(this,name,parent,main);
};
Module._extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const load=n=>require(path.join(root,n));
let db;
try {
 db=load('lib/db.ts').getDb();const data=load('lib/data.ts'), sync=load('lib/repo-sync.ts'),io=load('lib/sync-io.ts');
 const fixture=()=>{remote=new Map();head='r1';afterRead=afterPush=null;failRead=failPush=false;const space=data.createSpace({name:'Sync '+checks,visibility:'private'});sync.saveRepoSettings(space.id,{provider:'github',endpoint:'https://example.test',repo:'test/docs',branch:'main',path:'',token:'fixture'});return space;};
 const count=s=>db.prepare('SELECT count(*) AS n FROM pages WHERE space_id=?').get(s.id).n;
 const run=async(name,test)=>{await test();checks++;console.log('ok',name);};
 const md=(body,title='Guide')=>`---\ntitle: "${title}"\n---\n\n${body}\n`;
 await run('remote-only pull creates draft in original space; repeat is no-op despite Markdown normalization',async()=>{
  const s=fixture(),spaces=db.prepare('SELECT count(*) AS n FROM spaces').get().n;remote.set('nested/guide.md',md('One'));
  let r=await sync.syncWithRepo(s);assert.equal(r.pulled,1);assert.equal(r.error,undefined);assert.equal(count(s),1);assert.equal(db.prepare('SELECT count(*) AS n FROM spaces').get().n,spaces);
  const p=db.prepare('SELECT * FROM pages WHERE space_id=?').get(s.id);assert.equal(p.published,0);
  r=await sync.syncWithRepo(s);assert.equal(r.pulled,0);assert.equal(r.pushed,0);assert.equal(r.conflicts.length,0);assert.equal(r.unchanged,1);assert.equal(count(s),1);
  remote.set('nested/guide.md',md('Two'));r=await sync.syncWithRepo(s);assert.equal(r.pulled,1);assert.equal(count(s),1);assert.match(data.getPage(p.id).content_text,/Two/);
 });
 await run('local push then remote pull preserves original ID and hierarchy',async()=>{
  const s=fixture(),parent=data.createPage({spaceId:s.id,title:'Parent',published:true}),p=data.createPage({spaceId:s.id,parentId:parent.id,title:'Guide',published:true});
  let r=await sync.syncWithRepo(s);assert.equal(r.pushed,2);remote.set('parent/guide.md',md('Changed','Renamed'));
  r=await sync.syncWithRepo(s);assert.equal(r.pulled,1);assert.equal(data.getPage(p.id).parent_id,parent.id);assert.equal(data.getPage(p.id).published,1);assert.equal(count(s),2);
  r=await sync.syncWithRepo(s);assert.equal(r.pulled,0);assert.equal(r.conflicts.length,0);
 });
 await run('equal content advances baseline and later single-side edit pushes without false conflict',async()=>{
  const s=fixture(),p=data.createPage({spaceId:s.id,title:'Guide',published:true});await sync.syncWithRepo(s);
  data.savePage(p.id,{content:JSON.stringify([{id:'one',type:'paragraph',content:[{type:'text',text:'Both',styles:{}}],children:[]}])});remote.set('guide.md',io.pageToMarkdown(data.getPage(p.id)));
  let r=await sync.syncWithRepo(s);assert.equal(r.unchanged,1);data.savePage(p.id,{content:'[]'});r=await sync.syncWithRepo(s);assert.equal(r.pushed,1);assert.equal(r.conflicts.length,0);
 });
 await run('both sides changed preserve both revisions and persist conflict reason',async()=>{
  const s=fixture(),p=data.createPage({spaceId:s.id,title:'Guide',published:true});await sync.syncWithRepo(s);data.savePage(p.id,{title:'Local'});remote.set('guide.md',md('Remote'));
  const before=data.getPage(p.id).content,r=await sync.syncWithRepo(s);assert.equal(r.conflicts.length,1);assert.equal(r.pushed+r.pulled,0);assert.equal(data.getPage(p.id).content,before);assert.equal(sync.getLastRepoReport(s.id).conflicts.length,1);
 });
 await run('deleted or renamed remote files never delete pages or create duplicate identities',async()=>{
  const s=fixture(),p=data.createPage({spaceId:s.id,title:'Guide',published:true});await sync.syncWithRepo(s);remote.set('renamed.md',remote.get('guide.md'));remote.delete('guide.md');
  const r=await sync.syncWithRepo(s);assert.equal(r.pulled+r.pushed,0);assert.equal(r.conflicts.length,2);assert.ok(data.getPage(p.id));assert.equal(count(s),1);
 });
 await run('deleted local page is not resurrected or silently deleted remotely',async()=>{
  const s=fixture(),p=data.createPage({spaceId:s.id,title:'Guide',published:true});await sync.syncWithRepo(s);data.deletePage(p.id);const r=await sync.syncWithRepo(s);assert.equal(r.pulled+r.pushed,0);assert.equal(r.conflicts.length,1);assert.ok(remote.has('guide.md'));assert.equal(count(s),0);
 });
 await run('local move is held rather than duplicated',async()=>{
  const s=fixture(),p=data.createPage({spaceId:s.id,title:'Guide',published:true});await sync.syncWithRepo(s);db.prepare('UPDATE pages SET slug=? WHERE id=?').run('moved',p.id);const r=await sync.syncWithRepo(s);assert.equal(r.conflicts.length,1);assert.equal(r.pushed+r.pulled,0);assert.equal(remote.size,1);
 });
 await run('partial remote read failure applies nothing',async()=>{
  const s=fixture();remote.set('a.md',md('A'));remote.set('b.md',md('B'));failRead=true;const r=await sync.syncWithRepo(s);assert.match(r.error,/read failed/);assert.equal(count(s),0);assert.equal(db.prepare('SELECT count(*) AS n FROM repo_sync_baselines WHERE space_id=?').get(s.id).n,0);
 });
 await run('local changes during network read are not overwritten',async()=>{
  const s=fixture(),p=data.createPage({spaceId:s.id,title:'Guide',published:true});await sync.syncWithRepo(s);remote.set('guide.md',md('Remote'));afterRead=()=>data.savePage(p.id,{title:'Concurrent'});const r=await sync.syncWithRepo(s);assert.match(r.error,/changed during sync/);assert.equal(data.getPage(p.id).title,'Concurrent');assert.equal(r.pulled,0);
 });
 await run('push failure does not import pending remote files or advance state',async()=>{
  const s=fixture();data.createPage({spaceId:s.id,title:'Local'});remote.set('remote.md',md('Remote'));failPush=true;const r=await sync.syncWithRepo(s);assert.match(r.error,/push rejected/);assert.equal(count(s),1);assert.equal(db.prepare('SELECT count(*) AS n FROM repo_sync_baselines WHERE space_id=?').get(s.id).n,0);
 });
 await run('remote commit followed by local race is reported honestly and retry converges safely',async()=>{
  const s=fixture(),p=data.createPage({spaceId:s.id,title:'Guide',published:true});afterPush=()=>data.savePage(p.id,{title:'Concurrent'});let r=await sync.syncWithRepo(s);assert.equal(r.pushed,1);assert.ok(r.commit);assert.match(r.error,/Remote commit/);assert.equal(data.getPage(p.id).title,'Concurrent');r=await sync.syncWithRepo(s);assert.equal(r.conflicts.length,1);assert.equal(r.pushed,0);
 });
 await run('SQLite failure rolls back all pulled pages and baselines',async()=>{
  const s=fixture();remote.set('a.md',md('A','A'));remote.set('b.md',md('B','Reject'));db.exec("CREATE TEMP TRIGGER reject_sync BEFORE INSERT ON pages WHEN NEW.title='Reject' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;");
  const r=await sync.syncWithRepo(s);db.exec('DROP TRIGGER reject_sync');assert.match(r.error,/fixture rollback/);assert.equal(r.pulled,0);assert.equal(count(s),0);assert.equal(db.prepare('SELECT count(*) AS n FROM repo_sync_baselines WHERE space_id=?').get(s.id).n,0);
 });
 await run('connection changes clear previous repository baselines',async()=>{
  const s=fixture();data.createPage({spaceId:s.id,title:'Guide'});await sync.syncWithRepo(s);sync.saveRepoSettings(s.id,{...sync.getRepoSettings(s.id),branch:'other',token:''});assert.equal(db.prepare('SELECT count(*) AS n FROM repo_sync_baselines WHERE space_id=?').get(s.id).n,0);
 });
 await run('legacy repo_state migrates attribution without duplicate import',async()=>{
  const s=fixture(),p=data.createPage({spaceId:s.id,title:'Guide',published:true}),text=io.pageToMarkdown(p);db.prepare('INSERT INTO repo_state VALUES(?,?,?,?,?)').run(s.id,'guide.md',p.id,io.sha(text),Date.now());remote.set('guide.md',md('New'));const r=await sync.syncWithRepo(s);assert.equal(r.pulled,1);assert.equal(count(s),1);assert.match(data.getPage(p.id).content_text,/New/);
 });
 await run('rich editor properties are never discarded by Markdown pull',async()=>{
  const s=fixture(),content=JSON.stringify([{id:'rich',type:'paragraph',props:{},content:[{type:'text',text:'Color',styles:{textColor:'red'}}],children:[]}]),p=data.createPage({spaceId:s.id,title:'Guide',content,published:true});await sync.syncWithRepo(s);remote.set('guide.md',md('Changed'));const r=await sync.syncWithRepo(s);assert.equal(r.pulled,0);assert.match(r.conflicts[0].why,/cannot preserve/);assert.equal(data.getPage(p.id).content,content);
 });
 await run('concurrent metadata invisible in Markdown is detected',async()=>{
  const s=fixture(),p=data.createPage({spaceId:s.id,title:'Guide',published:true});await sync.syncWithRepo(s);remote.set('guide.md',md('Changed'));afterRead=()=>db.prepare('UPDATE pages SET updated_by=? WHERE id=?').run('concurrent',p.id);const r=await sync.syncWithRepo(s);assert.match(r.error,/changed during sync/);assert.equal(r.pulled,0);
 });
 await run('block-anchored comments hold incoming replacement',async()=>{
  const s=fixture(),p=data.createPage({spaceId:s.id,title:'Guide',published:true});await sync.syncWithRepo(s);db.prepare('INSERT OR IGNORE INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run('commenter','commenter@example.test','C','!','member',Date.now());db.prepare('INSERT INTO comments(id,page_id,user_id,body,created_at,block_id) VALUES(?,?,?,?,?,?)').run('comment',p.id,'commenter','Keep this',Date.now(),'block');remote.set('guide.md',md('Changed'));const r=await sync.syncWithRepo(s);assert.equal(r.pulled,0);assert.match(r.conflicts[0].why,/anchored/);
 });
 await run('pre-pull snapshot records exact latest JSON even with recent normal version',async()=>{
  const s=fixture(),p=data.createPage({spaceId:s.id,title:'Guide',published:true});await sync.syncWithRepo(s);remote.set('guide.md',md('One'));await sync.syncWithRepo(s);const before=data.getPage(p.id);remote.set('guide.md',md('Two'));const r=await sync.syncWithRepo(s);assert.equal(r.pulled,1);const revisions=db.prepare('SELECT page_json FROM repo_sync_revisions WHERE page_id=?').all(p.id);assert.ok(revisions.some(x=>x.page_json===JSON.stringify(before)));
 });
 await run('unchanged unique blocks retain IDs; imported relative page links resolve',async()=>{
  const s=fixture();remote.set('a.md',md('[Other](nested/b.md)\n\nStable paragraph'));remote.set('nested/b.md',md('Target','Target'));await sync.syncWithRepo(s);const rows=db.prepare('SELECT * FROM pages WHERE space_id=? ORDER BY title').all(s.id),a=rows.find(p=>p.title==='Guide'),b=rows.find(p=>p.title==='Target');assert.ok(a.content.includes(`/${s.slug}/${b.slug}`));const stable=JSON.parse(a.content).find(block=>JSON.stringify(block).includes('Stable paragraph'));remote.set('a.md',md('[Other](nested/b.md)\n\nStable paragraph\n\nNew paragraph'));let r=await sync.syncWithRepo(s);assert.equal(r.pulled,1);assert.ok(JSON.parse(data.getPage(a.id).content).some(block=>block.id===stable.id));r=await sync.syncWithRepo(s);assert.equal(r.pulled+r.pushed,0);
 });
 await run('duplicate legacy bindings fail closed before application',async()=>{
  const s=fixture(),p=data.createPage({spaceId:s.id,title:'Guide'});for(const name of ['a.md','b.md'])db.prepare('INSERT INTO repo_state VALUES(?,?,?,?,?)').run(s.id,name,p.id,'old',Date.now());const r=await sync.syncWithRepo(s);assert.match(r.error,/Ambiguous repository bindings/);assert.equal(r.pulled+r.pushed,0);
 });
 await run('duplicated incoming paragraph never duplicates block IDs',async()=>{
  const s=fixture();remote.set('guide.md',md('Unique'));await sync.syncWithRepo(s);const p=db.prepare('SELECT * FROM pages WHERE space_id=?').get(s.id);remote.set('guide.md',md('Unique\n\nUnique'));const r=await sync.syncWithRepo(s);assert.equal(r.pulled,1);const blocks=JSON.parse(data.getPage(p.id).content);assert.equal(new Set(blocks.map(b=>b.id)).size,blocks.length);
 });
 await run('anchor added while remote push awaits prevents local replacement',async()=>{
  const s=fixture(),p=data.createPage({spaceId:s.id,title:'Guide',published:true});await sync.syncWithRepo(s);data.createPage({spaceId:s.id,title:'Outbound'});remote.set('guide.md',md('Remote edit'));afterPush=()=>db.prepare('INSERT INTO comments(id,page_id,user_id,body,created_at,block_id) VALUES(?,?,?,?,?,?)').run('late-comment',p.id,'commenter','Keep this',Date.now(),'block');const before=data.getPage(p.id).content,r=await sync.syncWithRepo(s);assert.match(r.error,/anchored/);assert.equal(r.pulled,0);assert.equal(r.pushed,1);assert.equal(data.getPage(p.id).content,before);
 });
 await run('persisted Yjs document is never left stale by in-place pull',async()=>{
  const s=fixture(),p=data.createPage({spaceId:s.id,title:'Guide',published:true});await sync.syncWithRepo(s);const Y=require('yjs'),doc=new Y.Doc();doc.getText('fixture').insert(0,'Original shared state');const state=Buffer.from(Y.encodeStateAsUpdate(doc));db.prepare('INSERT INTO collab_docs(page_id,state,updated_at) VALUES(?,?,?)').run(p.id,state,Date.now());remote.set('guide.md',md('Remote replacement'));const r=await sync.syncWithRepo(s);assert.equal(r.pulled,0);assert.match(r.conflicts[0].why,/Collaborative/);assert.equal(data.getPage(p.id).content,'[]');assert.deepEqual(db.prepare('SELECT state FROM collab_docs WHERE page_id=?').get(p.id).state,state);doc.destroy();
 });
 await run('zero-byte collaboration seed claim blocks pull',async()=>{
  const s=fixture(),p=data.createPage({spaceId:s.id,title:'Guide',published:true});await sync.syncWithRepo(s);assert.equal(load('lib/collab-seed.ts').claimSeed(p.id),true);remote.set('guide.md',md('Remote'));const r=await sync.syncWithRepo(s);assert.equal(r.pulled,0);assert.match(r.conflicts[0].why,/Collaborative/);
 });
 await run('enabled collaboration blocks replacement even before persistence or seed',async()=>{
  const s=fixture(),p=data.createPage({spaceId:s.id,title:'Guide',published:true});await sync.syncWithRepo(s);process.env.OCTAVO_COLLAB='1';try{remote.set('guide.md',md('Remote'));const r=await sync.syncWithRepo(s);assert.equal(r.pulled,0);assert.match(r.conflicts[0].why,/Collaborative/);assert.equal(data.getPage(p.id).content,'[]');}finally{process.env.OCTAVO_COLLAB='0';}
 });
 await run('collaboration claimed during outbound await rolls back local replacement',async()=>{
  const s=fixture(),p=data.createPage({spaceId:s.id,title:'Guide',published:true});await sync.syncWithRepo(s);data.createPage({spaceId:s.id,title:'Outbound'});remote.set('guide.md',md('Remote'));afterPush=()=>load('lib/collab-seed.ts').claimSeed(p.id);const r=await sync.syncWithRepo(s);assert.equal(r.pulled,0);assert.equal(r.pushed,1);assert.match(r.error,/Collaborative/);assert.equal(data.getPage(p.id).content,'[]');
 });
 await run('experimental coordinated pull updates page and Yjs at one new epoch',async()=>{
  const s=fixture(),p=data.createPage({spaceId:s.id,title:'Guide',published:true});await sync.syncWithRepo(s);
  const shared=load('lib/repo-collab.ts'),versions=load('lib/page-revisions.ts');
  db.transaction(()=>shared.replaceSharedDocument(p.id,shared.materializeRepoDocument([])))();
  const before=versions.pageRevision(p.id),oldState=db.prepare('SELECT state FROM collab_docs WHERE page_id=?').get(p.id).state;
  process.env.OCTAVO_COLLAB='1';process.env.OCTAVO_REPO_COLLAB_SYNC='experimental';
  try{remote.set('guide.md',md('Coordinated remote'));const r=await sync.syncWithRepo(s);assert.equal(r.error,undefined);assert.equal(r.pulled,1);assert.equal(versions.pageRevision(p.id).epoch,before.epoch+1);assert.equal(shared.sharedDocumentSafety(p.id,data.getPage(p.id).content),null);const snapshot=db.prepare('SELECT * FROM repo_sync_revisions WHERE page_id=?').get(p.id);assert.deepEqual(snapshot.collab_state,oldState);assert.equal(snapshot.collab_epoch,before.epoch);assert.equal((await sync.syncWithRepo(s)).pulled,0);}
  finally{process.env.OCTAVO_COLLAB='0';delete process.env.OCTAVO_REPO_COLLAB_SYNC;}
 });
 await run('experimental pull holds active editor and unprojected shared edits',async()=>{
  const s=fixture(),p=data.createPage({spaceId:s.id,title:'Guide',published:true});await sync.syncWithRepo(s);const shared=load('lib/repo-collab.ts');
  process.env.OCTAVO_COLLAB='1';process.env.OCTAVO_REPO_COLLAB_SYNC='experimental';
  try{remote.set('guide.md',md('Remote'));db.prepare('INSERT INTO collab_room_leases VALUES(?,?,?,?)').run(p.id,'active-test',0,Date.now()+60000);let r=await sync.syncWithRepo(s);assert.equal(r.pulled,0);assert.match(r.conflicts[0].why,/active/);db.prepare('DELETE FROM collab_room_leases WHERE page_id=?').run(p.id);db.transaction(()=>shared.replaceSharedDocument(p.id,shared.materializeRepoDocument([{id:'x',type:'paragraph',content:[{type:'text',text:'Unprojected',styles:{}}],children:[]}])) )();r=await sync.syncWithRepo(s);assert.equal(r.pulled,0);assert.match(r.conflicts[0].why,/not reflected/);assert.equal(data.getPage(p.id).content,'[]');}
  finally{process.env.OCTAVO_COLLAB='0';delete process.env.OCTAVO_REPO_COLLAB_SYNC;}
 });
 await run('experimental application rollback preserves Yjs bytes and epoch',async()=>{
  const s=fixture(),p=data.createPage({spaceId:s.id,title:'Guide',published:true});await sync.syncWithRepo(s);const shared=load('lib/repo-collab.ts'),versions=load('lib/page-revisions.ts');db.transaction(()=>shared.replaceSharedDocument(p.id,shared.materializeRepoDocument([])))();const before=versions.pageRevision(p.id),bytes=db.prepare('SELECT state FROM collab_docs WHERE page_id=?').get(p.id).state;
  process.env.OCTAVO_COLLAB='1';process.env.OCTAVO_REPO_COLLAB_SYNC='experimental';
  try{remote.set('guide.md',md('Remote'));db.exec("CREATE TEMP TRIGGER reject_epoch_report BEFORE INSERT ON repo_sync_reports BEGIN SELECT RAISE(ABORT,'epoch rollback'); END;");const r=await sync.syncWithRepo(s);db.exec('DROP TRIGGER reject_epoch_report');assert.match(r.error,/epoch rollback/);assert.equal(r.pulled,0);assert.equal(data.getPage(p.id).content,'[]');assert.deepEqual(versions.pageRevision(p.id),before);assert.deepEqual(db.prepare('SELECT state FROM collab_docs WHERE page_id=?').get(p.id).state,bytes);}
  finally{process.env.OCTAVO_COLLAB='0';delete process.env.OCTAVO_REPO_COLLAB_SYNC;}
 });
 await run('late active-room lease prevents coordinated replacement',async()=>{
  const s=fixture(),p=data.createPage({spaceId:s.id,title:'Guide',published:true});await sync.syncWithRepo(s);data.createPage({spaceId:s.id,title:'Outbound'});
  process.env.OCTAVO_COLLAB='1';process.env.OCTAVO_REPO_COLLAB_SYNC='experimental';
  try{remote.set('guide.md',md('Remote'));afterPush=()=>db.prepare('INSERT INTO collab_room_leases VALUES(?,?,?,?)').run(p.id,'late-test',0,Date.now()+60000);const r=await sync.syncWithRepo(s);assert.equal(r.pulled,0);assert.match(r.error,/active/);assert.equal(data.getPage(p.id).content,'[]');}
  finally{process.env.OCTAVO_COLLAB='0';delete process.env.OCTAVO_REPO_COLLAB_SYNC;}
 });
 await run('actual GitHub HTTP adapter + SQLite round trip, repeated pull and conflict',async()=>{
  const space=fixture(),p=data.createPage({spaceId:space.id,title:'Guide',published:true});
  const real=load('lib/git-host.ts');Object.assign(adapter,real);
  let revision='a'.repeat(40), sequence=1;const files=new Map(),blobs=new Map();let tree,commit;
  const server=createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
   const url=new URL(req.url,'http://localhost'),body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
   const send=(status,value)=>res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(value));
   if(url.pathname.endsWith('/git/ref/heads/main'))return send(200,{object:{sha:revision}});
   if(req.method==='GET'&&url.pathname.includes('/git/trees/')) {assert.equal(url.pathname.split('/').pop(),revision);return send(200,{tree:[...files.keys()].map(path=>({path,type:'blob',sha:'b'.repeat(40)})),truncated:false});}
   if(req.method==='GET'&&url.pathname.includes('/contents/')) {assert.equal(url.searchParams.get('ref'),revision);const name=url.pathname.split('/contents/')[1];return send(200,{encoding:'base64',content:Buffer.from(files.get(name)).toString('base64')});}
   if(url.pathname.endsWith('/git/blobs')) {const sha=String(sequence++).padStart(40,'0');blobs.set(sha,Buffer.from(body.content,'base64').toString());return send(201,{sha});}
   if(url.pathname.endsWith('/git/trees')) {tree=body;assert.equal(tree.base_tree,revision);return send(201,{sha:'c'.repeat(40)});}
   if(url.pathname.endsWith('/git/commits')) {commit=body;assert.equal(commit.parents[0],revision);return send(201,{sha:'d'.repeat(40)});}
   if(url.pathname.endsWith('/git/refs/heads/main')) {assert.equal(body.force,false);for(const item of tree.tree)files.set(item.path,blobs.get(item.sha));revision=body.sha;return send(200,{object:{sha:revision}});}
   return send(404,{message:'unexpected fixture request'});
  });});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
   sync.saveRepoSettings(space.id,{...sync.getRepoSettings(space.id),endpoint:`http://127.0.0.1:${server.address().port}`,token:''});
   let result=await sync.syncWithRepo(space);assert.equal(result.error,undefined);assert.equal(result.pushed,1);assert.ok(files.has('guide.md'));
   files.set('guide.md',md('HTTP remote edit'));revision='e'.repeat(40);
   result=await sync.syncWithRepo(space);assert.equal(result.error,undefined);assert.equal(result.pulled,1);assert.equal(count(space),1);assert.match(data.getPage(p.id).content_text,/HTTP remote edit/);
   result=await sync.syncWithRepo(space);assert.equal(result.error,undefined);assert.equal(result.pulled+result.pushed,0);assert.equal(result.unchanged,1);
   data.savePage(p.id,{title:'Local edit'});files.set('guide.md',md('Concurrent remote'));revision='f'.repeat(40);
   result=await sync.syncWithRepo(space);assert.equal(result.conflicts.length,1);assert.equal(result.pulled+result.pushed,0);assert.equal(data.getPage(p.id).title,'Local edit');
  } finally {await new Promise(resolve=>server.close(resolve));}
 });
 console.log(`${checks} repository reconciliation integration cases passed`);
} finally {db?.close();delete globalThis.__octavoDb;Module._load=originalLoad;Module._extensions['.ts']=originalTs;fs.rmSync(dir,{recursive:true,force:true});}
