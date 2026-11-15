// Actual PATCH route + data model + SQLite; authentication identity is a fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),root=path.resolve('src'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-editor-revision-'));
process.env.OCTAVO_DATA_DIR=dir;
const originalLoad=Module._load, originalTs=Module._extensions['.ts'];
let user={id:'admin',name:'Admin',email:'admin@example.test',role:'admin'},db,checks=0;
Module._load=function(name,parent,main){
 if(name==='server-only')return {};
 if(name==='@/lib/auth')return {currentUser:async()=>user};
 if(name==='./audit-forward')return {forwardAudit:()=>{}};
 if(name==='next/headers')return {cookies:async()=>({get:()=>undefined}),headers:async()=>new Map()};
 if(name.startsWith('@/'))name=path.join(root,name.slice(2));
 return originalLoad.call(this,name,parent,main);
};
Module._extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const load=n=>require(path.join(root,n)),check=async(name,fn)=>{await fn();checks++;console.log('ok',name);};
try {
 const dbmod=load('lib/db.ts');db=dbmod.getDb();const data=load('lib/data.ts'),revisions=load('lib/page-revisions.ts'),{NextRequest}=require('next/server'),route=load('app/api/pages/[id]/route.ts').PATCH;
 const space=data.createSpace({name:'Editor revision test',visibility:'private'}),page=data.createPage({spaceId:space.id,title:'Original'});
 const request=body=>route(new NextRequest(`http://localhost/api/pages/${page.id}`,{method:'PATCH',body:JSON.stringify(body),headers:{'content-type':'application/json'}}),{params:Promise.resolve({id:page.id})});
 await check('missing expected revision is rejected without modifying content',async()=>{const r=await request({title:'Unversioned overwrite'});assert.equal(r.status,428);assert.equal(data.getPage(page.id).title,'Original');assert.equal(typeof (await r.json()).current.revision,'number');});
 await check('bad revision or epoch is rejected',async()=>{for(const body of [{expectedRevision:-1},{expectedRevision:1.1},{expectedRevision:'0'},{expectedRevision:0,expectedEpoch:-1}])assert.equal((await request({...body,title:'Invalid'})).status,400);assert.equal(data.getPage(page.id).title,'Original');});
 await check('same-base editors cannot overwrite each other',async()=>{const base=revisions.pageRevision(page.id);const [a,b]=await Promise.all([request({title:'First',expectedRevision:base.revision,expectedEpoch:base.epoch}),request({title:'Second',expectedRevision:base.revision,expectedEpoch:base.epoch})]);assert.deepEqual([a.status,b.status].sort(),[200,409]);assert.equal(data.getPage(page.id).title,'First');const saved=await a.json();assert.ok(saved.revision>base.revision);assert.equal(saved.epoch,base.epoch);});
 await check('stale full content rejected and newer server document preserved',async()=>{const base=revisions.pageRevision(page.id);data.savePage(page.id,{content:JSON.stringify([{id:'new',type:'paragraph',content:[{type:'text',text:'Newer server content',styles:{}}],children:[]}])});const before=data.getPage(page.id).content;const r=await request({content:[],expectedRevision:base.revision,expectedEpoch:base.epoch});assert.equal(r.status,409);assert.equal(data.getPage(page.id).content,before);});
 await check('stale epoch rejected even with a current revision',async()=>{const base=revisions.pageRevision(page.id);db.prepare('UPDATE page_edit_versions SET epoch=epoch+1 WHERE page_id=?').run(page.id);const r=await request({title:'Old epoch',expectedRevision:base.revision,expectedEpoch:base.epoch});assert.equal(r.status,409);assert.equal((await r.json()).current.epoch,base.epoch+1);assert.notEqual(data.getPage(page.id).title,'Old epoch');});
 await check('matching revision and epoch saves and returns atomic new version',async()=>{const base=revisions.pageRevision(page.id);const r=await request({title:'Current save',expectedRevision:base.revision,expectedEpoch:base.epoch});assert.equal(r.status,200);const saved=await r.json();assert.deepEqual({revision:saved.revision,epoch:saved.epoch},revisions.pageRevision(page.id));assert.equal(data.getPage(page.id).title,'Current save');});
 await check('revision survives database close and reopen',async()=>{const base=revisions.pageRevision(page.id);db.close();delete globalThis.__octavoDb;db=dbmod.getDb();assert.deepEqual(revisions.pageRevision(page.id),base);const r=await request({title:'Stale after restart',expectedRevision:base.revision-1,expectedEpoch:base.epoch});assert.equal(r.status,409);assert.equal(data.getPage(page.id).title,'Current save');});
 await check('authorization remains ahead of revision details',async()=>{user=null;assert.equal((await request({})).status,401);user={id:'reader',name:'Reader',email:'reader@example.test',role:'reader'};assert.equal((await request({})).status,403);});
 console.log(`${checks} editor revision integration cases passed`);
} finally {db?.close();delete globalThis.__octavoDb;Module._load=originalLoad;Module._extensions['.ts']=originalTs;fs.rmSync(dir,{recursive:true,force:true});}
