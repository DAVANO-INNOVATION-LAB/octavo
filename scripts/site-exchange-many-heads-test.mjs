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
 principal={id:'admin',role:'admin'};
 const {s,lineage,remote}=fixture();const base=remote.capture(lineage,'many-heads',body('base'));
 await app.importExchange(s.id,remote.exportBundle(lineage),'admin');const original=mapping(lineage,'many-heads').page_id;
 for(let i=0;i<101;i++)remote.capture(lineage,'many-heads',body('branch '+i),[base]);
 await app.importExchange(s.id,remote.exportBundle(lineage),'admin');
 const heads=app.exchangeEngine().engine.heads(lineage,'many-heads');assert.equal(heads.length,101);
 const request=(expectedHeads)=>new NextRequest('http://localhost:9999/api/site-exchange',{method:'POST',headers:{Origin:'http://localhost:9999',Host:'localhost:9999','Content-Type':'application/json'},body:JSON.stringify({action:'resolve',spaceId:s.id,docId:'many-heads',selectedRevision:heads[0].id,expectedHeads})});
 await run('actual API resolves101 exact heads atomically retaining original page and all ancestry',async()=>{
  const response=await route.POST(request(heads.map(h=>h.id)));assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
  const engine=app.exchangeEngine().engine,remaining=engine.heads(lineage,'many-heads');assert.equal(remaining.length,1);assert.equal(mapping(lineage,'many-heads').page_id,original);assert.equal(data.getPage(original).content,heads[0].body.content);
  const history=engine.revisions(lineage,'many-heads');assert.ok(history.every(r=>r.parents.length<=100));for(const h of heads)assert.ok(history.some(r=>r.id===h.id));
 });
 await run('stale many-head decision and oversized set cannot change resolved state',async()=>{
  const before=app.exchangeEngine().engine.revisions(lineage,'many-heads').length;
  assert.equal((await route.POST(request(heads.map(h=>h.id)))).status,409);
  assert.equal((await route.POST(request(Array(5001).fill(heads[0].id)))).status,409);
  assert.equal(app.exchangeEngine().engine.revisions(lineage,'many-heads').length,before);
 });
 console.log(`${tests} many-head API integration groups passed`);
}finally{db.close();Module._load=oldLoad;Module._extensions['.ts']=oldTs;fs.rmSync(dir,{recursive:true,force:true});}
