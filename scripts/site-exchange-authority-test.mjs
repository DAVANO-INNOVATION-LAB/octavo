import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {createHash,sign} from 'node:crypto';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import ts from 'typescript';
import Database from 'better-sqlite3';
import * as Core from '@blocknote/core';
import * as Yjs from '@blocknote/core/yjs';
import * as Y from 'yjs';
const require=createRequire(import.meta.url),root=path.resolve('src'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-site-app-'));
process.env.OCTAVO_DATA_DIR=dir;process.env.OCTAVO_COLLAB='0';
let copiedOriginalPages=null,copySourceHash=null;
if(process.env.EXCHANGE_TEST_DATA_COPY){
 const source=process.env.EXCHANGE_TEST_DATA_COPY;copySourceHash=createHash('sha256').update(fs.readFileSync(source)).digest('hex');
 const sourceDb=new Database(source,{readonly:true,fileMustExist:true});try{await sourceDb.backup(path.join(dir,'octavo.db'));}finally{sourceDb.close();}
 const seed=new Database(path.join(dir,'octavo.db'),{readonly:true});
 const columns=seed.pragma('table_info(pages)').map(c=>c.name),quoteSql=columns.map(c=>'quote("'+c.replaceAll('"','""')+'") AS "'+c.replaceAll('"','""')+'"').join(',');
 const original=seed.prepare('SELECT '+quoteSql+' FROM pages ORDER BY id').all();
 copiedOriginalPages={columns,quoteSql,original,ids:seed.prepare('SELECT id FROM pages ORDER BY id').all().map(p=>p.id)};seed.close();
}

// Optional schema-only upgrade fixture; never opens or copies source records.
if(process.env.EXCHANGE_TEST_SCHEMA){const seed=new Database(path.join(dir,'octavo.db'));try{seed.exec(fs.readFileSync(process.env.EXCHANGE_TEST_SCHEMA,'utf8'));}finally{seed.close();}}
const oldLoad=Module._load,oldTs=Module._extensions['.ts'];let principal=null;
Module._load=function(name,parent,main){if(name==='@/lib/auth'&&parent?.filename.endsWith('/api/site-exchange/route.ts'))return {currentUser:async()=>principal};if(name==='server-only')return {};if(name==='@blocknote/core')return Core;if(name==='@blocknote/core/yjs')return Yjs;if(name==='yjs')return Y;if(name==='next/headers')return {cookies:async()=>({get:()=>undefined}),headers:async()=>new Map()};if(name==='./audit-forward')return {forwardAudit:()=>{}};if(name.startsWith('@/'))name=path.join(root,name.slice(2));return oldLoad.call(this,name,parent,main)};
Module._extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const data=require(path.join(root,'lib/data.ts')),app=require(path.join(root,'lib/site-exchange-app.ts')),{SiteExchange,canonical,exchangeHash}=require(path.join(root,'lib/site-exchange.ts')),{getDb,UPLOADS_DIR}=require(path.join(root,'lib/db.ts'));
const db=getDb();if(process.env.EXCHANGE_TEST_MIGRATE_LEGACY==='1')require(path.join(root,'lib/reviewed-legacy-fk-migration.ts')).migrateReviewedLegacyForeignKeys(db,{retainOrphans:!!process.env.EXCHANGE_TEST_DATA_COPY});let tests=0;
const body=text=>({title:'Guide',content:JSON.stringify([{id:'one',type:'paragraph',content:[{type:'text',text,styles:{}}],children:[]}]),parentDocId:null,deleted:false,attachments:[]});
const run=async(name,fn)=>{await fn();tests++;console.log('ok',name)};
function fixture(){const s=data.createSpace({name:'Exchange '+tests,visibility:'private'}),{lineage}=app.bindExchange(s.id),remote=new SiteExchange(new Database(':memory:'),SiteExchange.createIdentity());remote.bindScope('remote',lineage);app.trustExchange(s.id,remote.identity.publicKey);remote.trust(lineage,app.exchangeEngine().identity.publicKey);return {s,lineage,remote};}
const mapping=(lineage,doc)=>db.prepare('SELECT * FROM site_exchange_pages WHERE lineage=? AND doc_id=?').get(lineage,doc);
const route=require(path.join(root,'app/api/site-exchange/route.ts')),{NextRequest}=require('next/server'),staging=require(path.join(root,'lib/site-exchange-staging-app.ts'));
const {exchangeSessionAuthority}=require(path.join(root,'lib/site-exchange-authority.ts'));
principal={id:'authority-admin',email:'admin@example.invalid',name:'Admin',role:'admin'};
db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(principal.id,principal.email,principal.name,'none','admin',1);
const sid='authority-session';
function reset(){db.prepare('UPDATE users SET role=?,active=1 WHERE id=?').run('admin',principal.id);db.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?,?)').run(sid,principal.id,Date.now()+60000);}
function authFixture(){reset();const f=fixture();f.remote.capture(f.lineage,'doc',body('Remote'));return {...f,raw:f.remote.exportBundle(f.lineage),guard:exchangeSessionAuthority(sid,principal.id,f.s.id)};}
try{
 await run('session guard rejects missing expired mismatched and deactivated principals',()=>{const {s,guard}=authFixture();guard();assert.throws(exchangeSessionAuthority(undefined,principal.id,s.id),/authorization changed/);assert.throws(exchangeSessionAuthority(sid,'other',s.id),/authorization changed/);db.prepare('UPDATE sessions SET expires_at=0 WHERE id=?').run(sid);assert.throws(guard,/authorization changed/);reset();db.prepare('UPDATE users SET active=0 WHERE id=?').run(principal.id);assert.throws(guard,/authorization changed/);reset();db.prepare('DELETE FROM sessions WHERE id=?').run(sid);assert.throws(guard,/authorization changed/);});
 for(const mode of ['deactivate','demote','logout','space-ceiling']){
  await run('slow-body '+mode+' denies bind after initial authentication',async()=>{
   reset();const s=data.createSpace({name:'Slow body',visibility:'private'});let controller;
   const stream=new ReadableStream({start(c){controller=c;}});
   const req=new NextRequest('http://localhost:9999/api/site-exchange',{method:'POST',headers:{'content-type':'application/json',origin:'http://localhost:9999',host:'localhost:9999',cookie:'octavo_session='+sid},body:stream,duplex:'half'});
   const pending=route.POST(req);await new Promise(resolve=>setImmediate(resolve));
   if(mode==='deactivate')db.prepare('UPDATE users SET active=0 WHERE id=?').run(principal.id);
   if(mode==='demote')db.prepare('UPDATE users SET role=? WHERE id=?').run('member',principal.id);
   if(mode==='logout')db.prepare('DELETE FROM sessions WHERE id=?').run(sid);
   if(mode==='space-ceiling')db.prepare('INSERT INTO space_members VALUES(?,?,?,?)').run(s.id,principal.id,'agent',1);
   controller.enqueue(new TextEncoder().encode(JSON.stringify({spaceId:s.id,action:'bind'})));controller.close();
   assert.equal((await pending).status,403);assert.equal(db.prepare('SELECT 1 FROM site_exchange_bindings WHERE space_id=?').get(s.id),undefined);
  });
 }
 await run('async import rejects revoked session inside mutation transaction',async()=>{const {s,lineage,raw,guard}=authFixture();const pending=app.importExchange(s.id,raw,principal.id,guard);db.prepare('DELETE FROM sessions WHERE id=?').run(sid);await assert.rejects(pending,/authorization changed/);assert.equal(app.exchangeEngine().engine.revisions(lineage).length,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM pages WHERE space_id=?').get(s.id).n,0);});
 await run('async apply resolve deletion recheck authority before mutation',async()=>{const {s,lineage,guard}=authFixture();for(const make of [()=>app.applyExchange(s.id,principal.id,guard),()=>app.resolveExchange(s.id,'doc','no-revision',[],principal.id,guard),()=>app.acceptExchangeDeletion(s.id,'doc',[],guard)]){reset();const pending=make();db.prepare('UPDATE users SET role=? WHERE id=?').run('member',principal.id);await assert.rejects(pending,/authorization changed/);assert.equal(app.exchangeEngine().engine.revisions(lineage).length,0);}});
 await run('staging denies revoke after verifier await without retained bytes',async()=>{process.env.OCTAVO_EXCHANGE_STAGING='1';const {s,raw,guard}=authFixture();const pending=staging.stageExchangeBundle(s.id,raw,guard);db.prepare('DELETE FROM sessions WHERE id=?').run(sid);await assert.rejects(pending,/authorization changed/);assert.equal(staging.listStagedExchange(s.id).items.length,0);});
 await run('review download and staged import recheck current session',async()=>{const {s,lineage,raw,guard}=authFixture();const item=await staging.stageExchangeBundle(s.id,raw,guard);for(const make of [()=>staging.reviewStagedExchange(s.id,item.sha256,true,guard),()=>staging.importStagedExchange(s.id,item.sha256,principal.id,guard)]){reset();const pending=make();db.prepare('DELETE FROM sessions WHERE id=?').run(sid);await assert.rejects(pending,/authorization changed/);assert.equal(app.exchangeEngine().engine.revisions(lineage).length,0);}});
 console.log(tests+' exchange authorization groups passed');
}finally{db.close();Module._load=oldLoad;Module._extensions['.ts']=oldTs;fs.rmSync(dir,{recursive:true,force:true});}
