import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import ts from 'typescript';
import Database from 'better-sqlite3';
import * as Core from '@blocknote/core';
import * as Yjs from '@blocknote/core/yjs';
import * as Y from 'yjs';
const require=createRequire(import.meta.url),root=path.resolve('src'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-site-app-'));
process.env.OCTAVO_DATA_DIR=dir;process.env.OCTAVO_COLLAB='0';
// Optional schema-only upgrade fixture; never opens or copies source records.
if(process.env.EXCHANGE_TEST_SCHEMA){const seed=new Database(path.join(dir,'octavo.db'));try{seed.exec(fs.readFileSync(process.env.EXCHANGE_TEST_SCHEMA,'utf8'));}finally{seed.close();}}
const oldLoad=Module._load,oldTs=Module._extensions['.ts'];let principal=null;
Module._load=function(name,parent,main){if(name==='@/lib/auth'&&parent?.filename.endsWith('/api/site-exchange/route.ts'))return {currentUser:async()=>principal};if(name==='server-only')return {};if(name==='@blocknote/core')return Core;if(name==='@blocknote/core/yjs')return Yjs;if(name==='yjs')return Y;if(name==='next/headers')return {cookies:async()=>({get:()=>undefined}),headers:async()=>new Map()};if(name==='./audit-forward')return {forwardAudit:()=>{}};if(name.startsWith('@/'))name=path.join(root,name.slice(2));return oldLoad.call(this,name,parent,main)};
Module._extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const data=require(path.join(root,'lib/data.ts')),app=require(path.join(root,'lib/site-exchange-app.ts')),{SiteExchange}=require(path.join(root,'lib/site-exchange.ts')),{getDb,UPLOADS_DIR}=require(path.join(root,'lib/db.ts'));
const db=getDb();let tests=0;
const body=text=>({title:'Guide',content:JSON.stringify([{id:'one',type:'paragraph',content:[{type:'text',text,styles:{}}],children:[]}]),parentDocId:null,deleted:false,attachments:[]});
const run=async(name,fn)=>{await fn();tests++;console.log('ok',name)};
function fixture(){const s=data.createSpace({name:'Exchange '+tests,visibility:'private'}),{lineage}=app.bindExchange(s.id),remote=new SiteExchange(new Database(':memory:'),SiteExchange.createIdentity());remote.bindScope('remote',lineage);app.trustExchange(s.id,remote.identity.publicKey);remote.trust(lineage,app.exchangeEngine().identity.publicKey);return {s,lineage,remote};}
const mapping=(lineage,doc)=>db.prepare('SELECT * FROM site_exchange_pages WHERE lineage=? AND doc_id=?').get(lineage,doc);
const route=require(path.join(root,'app/api/site-exchange/route.ts')),{NextRequest:NativeNextRequest}=require('next/server');
 // Route tests retain their explicit principal stub, but exercise the real
 // session/active/role guard with matching disposable database records.
 class NextRequest extends NativeNextRequest {
  constructor(url,init={}){
   const headers=new Headers(init.headers);
   if(principal){
    db.prepare('INSERT OR IGNORE INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(principal.id,principal.id+'@route.invalid',principal.id,'none',principal.role,1);
    const sid='route-session-'+principal.id;
    db.prepare('INSERT OR REPLACE INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run(sid,principal.id,Date.now()+60000);
    headers.set('cookie','octavo_session='+sid);
   }
   super(url,{...init,headers});
  }
 }

const get=async(query)=>route.GET(new NextRequest('http://localhost:9999/api/site-exchange?'+new URLSearchParams(query)));
try{
 const {s,lineage,remote}=fixture();
 for(let i=0;i<105;i++)remote.capture(lineage,'page-'+String(i).padStart(3,'0'),{...body('page '+i),title:'Page '+i});
 for(let i=0;i<26;i++)remote.capture(lineage,'long-history',{...body('LONG-'+i+' '+ 'x'.repeat(12000)),title:'Long history'});
 await app.importExchange(s.id,remote.exportBundle(lineage),'admin');
 await run('106 documents reachable through bounded stable pages without duplicates',async()=>{
  const seen=[],pages=[];let after;
  do{const p=app.exchangeStatus(s.id,{after,limit:25});pages.push(p);seen.push(...p.documents.map(d=>d.docId));after=p.nextDocumentCursor??undefined;}while(after);
  assert.equal(seen.length,106);assert.equal(new Set(seen).size,106);assert.ok(pages.every(p=>p.documents.length<=25));assert.ok(seen.includes('page-104'));
 });
 const all=remote.revisions(lineage,'long-history');
 await run('26 retained revisions reachable without truncating history',async()=>{
  const seen=[];let historyAfter;
  do{const p=app.exchangeStatus(s.id,{docId:'long-history',historyAfter,historyLimit:7}).documents[0];seen.push(...p.history.map(r=>r.id));historyAfter=p.historyNextCursor??undefined;}while(historyAfter);
  assert.equal(seen.length,26);assert.equal(new Set(seen).size,26);assert.deepEqual([...seen].sort(),all.map(r=>r.id).sort());
 });
 await run('long preview can be fetched complete only within exact document lineage',async()=>{
  const preview=app.exchangeStatus(s.id,{docId:'long-history'}).documents[0].heads[0];assert.equal(preview.previewTruncated,true);assert.equal(preview.body.content.length,8192);
  const full=app.readExchangeRevision(s.id,'long-history',preview.id);assert.equal(full.previewTruncated,false);assert.ok(full.body.content.length>12000);assert.equal(full.body.content,remote.heads(lineage,'long-history')[0].body.content);
  assert.throws(()=>app.readExchangeRevision(s.id,'page-001',preview.id),/unavailable/);const other=fixture();assert.throws(()=>app.readExchangeRevision(other.s.id,'long-history',preview.id),/unavailable/);
 });
 await run('pagination bounds and history cursor scope reject malformed requests',async()=>{
  for(const options of [{limit:0},{limit:101},{limit:1.5},{historyLimit:21},{historyAfter:'abc'},{after:'x'.repeat(129)}])assert.throws(()=>app.exchangeStatus(s.id,options));
 });
 await run('actual GET full revision enforces authentication and direct-agent ceiling',async()=>{
  const id=all[0].id,q={spaceId:s.id,docId:'long-history',revision:id};principal=null;assert.equal((await get(q)).status,401);principal={id:'reader',role:'reader'};assert.equal((await get(q)).status,403);
  const uid='capped-pagination';db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(uid,'cap-page@example.test','Capped','none','admin',1);db.prepare('INSERT INTO space_members VALUES(?,?,?,?)').run(s.id,uid,'agent',1);principal={id:uid,role:'admin'};assert.equal((await get(q)).status,403);
  principal={id:'admin',role:'admin'};const r=await get(q);assert.equal(r.status,200);assert.equal((await r.json()).revision.body.content,all[0].body.content);assert.equal((await get({...q,docId:'page-001'})).status,400);assert.equal((await get({revision:id,docId:'long-history'})).status,400);assert.equal((await get({spaceId:s.id,limit:'101'})).status,400);
 });
 await run('long conflict resolution and retained restoration preserve full bytes',async()=>{
  const page=mapping(lineage,'long-history').page_id;data.savePage(page,{content:body('local '+ 'L'.repeat(14000)).content});db.prepare('UPDATE collab_docs SET state=? WHERE page_id=?').run(Buffer.from(require(path.join(root,'lib/collab-projection.ts')).seedSharedState(data.getPage(page).content)),page);remote.capture(lineage,'long-history',body('remote '+ 'R'.repeat(15000)));await app.importExchange(s.id,remote.exportBundle(lineage),'admin');
  const heads=app.exchangeEngine().engine.heads(lineage,'long-history');assert.equal(heads.length,2);const chosen=heads.find(r=>r.body.content.includes('remote'));await app.resolveExchange(s.id,'long-history',chosen.id,heads.map(r=>r.id),'admin');assert.equal(data.getPage(page).content,chosen.body.content);
  const historical=app.readExchangeRevision(s.id,'long-history',all[0].id);await app.resolveExchange(s.id,'long-history',historical.id,app.exchangeEngine().engine.heads(lineage,'long-history').map(r=>r.id),'admin');assert.equal(data.getPage(page).content,historical.body.content);
 });

 await run('encoded request permits escaped raw bundles but caps outer transport',async()=>{
  principal={id:'admin',role:'admin'};
  const bundle=JSON.stringify('"'.repeat(9*1024*1024));
  const wrapped=JSON.stringify({action:'import',spaceId:s.id,bundle});assert.ok(Buffer.byteLength(bundle)<32*1024*1024);assert.ok(Buffer.byteLength(wrapped)>34*1024*1024);
  const make=body=>new NextRequest('http://localhost:9999/api/site-exchange',{method:'POST',headers:{Host:'localhost:9999',Origin:'http://localhost:9999','Content-Type':'application/json'},body,duplex:'half'});
  const r=await route.POST(make(wrapped));assert.equal(r.status,409);assert.notEqual((await r.json()).error,'Request exceeds limit');
  let n=0,cancelled=false;const chunk=new Uint8Array(1024*1024),stream=new ReadableStream({pull(c){if(n++<66)c.enqueue(chunk);else c.close();},cancel(){cancelled=true;}});
  const tooLarge=await route.POST(make(stream));assert.equal(tooLarge.status,409);assert.equal((await tooLarge.json()).error,'Request exceeds limit');assert.equal(cancelled,true);
 });
 console.log(`${tests} exchange pagination/full-revision groups passed`);
}finally{db.close();Module._load=oldLoad;Module._extensions['.ts']=oldTs;fs.rmSync(dir,{recursive:true,force:true});}
