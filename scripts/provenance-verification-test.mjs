// Real import routes/action, sessions and SQLite; synthetic files and no outbound services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),root=path.resolve('src');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-provenance-verify-'));
process.env.OCTAVO_DATA_DIR=temporary;
const oldLoad=Module._load,oldTs=Module._extensions['.ts'],oldTsx=Module._extensions['.tsx'],oldFetch=globalThis.fetch,oldError=console.error;
let db,cookie,cacheFails=false,forwardFails=false,checks=0;
const errors=[];
class Redirect extends Error{constructor(location){super('redirect');this.location=location;}}
Module._load=function(name,parent,main){
 if(name==='server-only')return {};
 if(name==='next/headers')return {cookies:async()=>({get:key=>key==='octavo_session'&&cookie?{value:cookie}:undefined}),headers:async()=>new Map()};
 if(name==='next/navigation')return {redirect:location=>{throw new Redirect(location);}};
 if(name==='next/cache')return {revalidatePath:()=>{assert.equal(db.inTransaction,false);if(cacheFails)throw Error('synthetic cache failure');}};
 if(name==='@/lib/import-url')return {fetchGuarded:async()=>({body:'# URL report\n\nSynthetic report content',contentType:'text/markdown',finalUrl:'https://synthetic.invalid/report.md'})};
 if(name==='./audit-forward')return {forwardAudit:()=>{assert.equal(db.inTransaction,false);if(forwardFails)throw Error('synthetic forward failure');}};
 if(name.startsWith('@/components/'))return new Proxy({},{get:(_,key)=>key==='__esModule'?true:()=>null});
 if(name.startsWith('@/'))name=path.join(root,name.slice(2));
 return oldLoad.call(this,name,parent,main);
};
Module._extensions['.ts']=Module._extensions['.tsx']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,f);
globalThis.fetch=()=>{throw Error('Unexpected outbound request');};console.error=(...args)=>errors.push(args);
const load=name=>require(path.join(root,name));
const check=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;};
try {
 const database=load('lib/db.ts');db=database.getDb();
 const data=load('lib/data.ts'),roles=load('lib/roles.ts'),reports=load('lib/import-reports.ts');
 const {verifyImportProvenance}=load('lib/provenance-verification.ts');
 const upload=load('app/api/import/route.ts').POST,verifyPost=load('app/api/spaces/[slug]/import-report/verify/route.ts').POST;
 const {NextRequest}=require('next/server');
 const users={};for(const id of ['owner','reader','outsider']){
  users[id]={id,name:id,email:id+'@example.test',role:'member'};
  db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id,users[id].email,id,'!','member',Date.now());
  db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run('session-'+id,id,Date.now()+86400000);
 }
 cookie='session-owner';
 const notebook=JSON.stringify({cells:[{cell_type:'markdown',source:['# Verification\n\nSynthetic original']},{cell_type:'code',source:['print(1)'],outputs:[{data:{'image/png':Buffer.from('synthetic PNG').toString('base64')}}]}]});
 const form=new FormData();form.set('file',new File([notebook],'verify.ipynb'));
 const imported=await upload(new NextRequest('http://localhost/api/import',{method:'POST',body:form}));
 const space=data.getSpaceBySlug(imported.headers.get('location').slice(1));assert.ok(space);
 const report=reports.getImportReport(users.owner,space.id), baseline=report.provenance;
 const verify=()=>verifyImportProvenance(users.owner,space.id);
 const originalReceipt=db.prepare('SELECT report_json FROM import_reports WHERE space_id=?').get(space.id).report_json;
 const post=(headers={origin:'http://localhost',host:'localhost'})=>verifyPost(new Request('http://localhost/api/spaces/'+space.slug+'/import-report/verify',{method:'POST',headers}),{params:Promise.resolve({slug:space.slug})});
 const initial=verify();check(initial.status,'checked');check(initial.counts,{unchanged:baseline.pages.length+baseline.attachments.length,changed:0,missing:0,unavailable:0});check(initial.source.status,'not_checked');
 const response=await post();check(response.status,200);check(response.headers.get('cache-control'),'private, no-store');check(response.headers.get('vary'),'Cookie');check((await post({host:'localhost'})).status,403);check((await post({origin:'https://evil.test',host:'localhost'})).status,403);
 roles.setSpaceMember(space.id,'reader','reader');for(const actor of [users.reader,users.outsider,null])check(verifyImportProvenance(actor,space.id),null);
 cookie='session-reader';check((await post()).status,404);cookie='session-owner';
 const pageId=baseline.pages[0].pageId,oldPage=db.prepare('SELECT content FROM pages WHERE id=?').get(pageId).content;
 db.prepare('UPDATE pages SET content=? WHERE id=?').run('legitimate edit',pageId);check(verify().pages.find(p=>p.pageId===pageId).status,'changed');
 db.prepare('UPDATE pages SET content=? WHERE id=?').run(oldPage,pageId);check(verify().pages.find(p=>p.pageId===pageId).status,'unchanged');
 const foreign=data.createSpace({name:'Other private scope',visibility:'private'});
 db.prepare('UPDATE pages SET space_id=? WHERE id=?').run(foreign.id,pageId);check(verify().pages.find(p=>p.pageId===pageId).status,'missing');db.prepare('UPDATE pages SET space_id=? WHERE id=?').run(space.id,pageId);
 const file=baseline.attachments[0],filename=path.join(database.UPLOADS_DIR,file.name),saved=fs.readFileSync(filename);
 fs.writeFileSync(filename,'different bytes');check(verify().attachments[0].status,'changed');fs.writeFileSync(filename,saved);
 db.prepare('UPDATE uploads SET space_id=? WHERE name=?').run(foreign.id,file.name);check(verify().attachments[0].status,'missing');db.prepare('UPDATE uploads SET space_id=? WHERE name=?').run(space.id,file.name);
 fs.unlinkSync(filename);check(verify().attachments[0].status,'missing');fs.symlinkSync(path.join(temporary,'octavo.db'),filename);check(verify().attachments[0].status,'unavailable');fs.unlinkSync(filename);fs.mkdirSync(filename);check(verify().attachments[0].status,'unavailable');fs.rmdirSync(filename);fs.writeFileSync(filename,saved);
 fs.truncateSync(filename,65*1024*1024);check(verify().attachments[0].status,'unavailable');fs.writeFileSync(filename,saved);
 const originalRead=fs.readSync;fs.readSync=()=>{throw Error('synthetic unreadable');};try{check(verify().attachments[0].status,'unavailable');}finally{fs.readSync=originalRead;}
 const writeReceipt=value=>db.prepare('UPDATE import_reports SET report_json=? WHERE space_id=?').run(typeof value==='string'?value:JSON.stringify(value),space.id);
 for(const mutate of [
  d=>{delete d.provenance;},d=>{d.provenance=null;},d=>{d.provenance.schemaVersion=2;},d=>{d.provenance.source.id='other';},d=>{d.provenance.source.sha256='bad';},d=>{d.provenance.pages[0].contentSha256='bad';},d=>{d.provenance.pages.push(d.provenance.pages[0]);},d=>{d.provenance.attachments.push(d.provenance.attachments[0]);},d=>{d.provenance.attachments[0].name='../outside';},d=>{d.provenance.attachments[0].bytes=-1;},d=>{d.spaceId=foreign.id;},d=>{d.provenance.pages=Array(10001).fill(d.provenance.pages[0]);},
 ]){const bad=JSON.parse(originalReceipt);mutate(bad);writeReceipt(bad);const result=verify();check(result.status,'unavailable');check(result.pages.length+result.attachments.length,0);}
 writeReceipt('{broken');check(verify().status,'unavailable');writeReceipt(' '.repeat(8*1024*1024+1));check(verify().status,'unavailable');writeReceipt(originalReceipt);
 const serialized=JSON.stringify(verify());assert.ok(!serialized.includes('Synthetic original')&&!serialized.includes(baseline.source.sha256));checks++;
 check(db.prepare('SELECT report_json FROM import_reports WHERE space_id=?').get(space.id).report_json,originalReceipt,'verification never modifies receipt');check(fs.readFileSync(filename),saved,'verification never modifies file');
 db.prepare('INSERT INTO deleted_spaces(space_id,deleted_at,deleted_by) VALUES(?,?,?)').run(space.id,Date.now(),'owner');check(verify(),null);
 console.log(`PASS provenance verification: ${checks} checks`);
} finally {
 db?.close();Module._load=oldLoad;if(oldTs)Module._extensions['.ts']=oldTs;else delete Module._extensions['.ts'];if(oldTsx)Module._extensions['.tsx']=oldTsx;else delete Module._extensions['.tsx'];globalThis.fetch=oldFetch;console.error=oldError;fs.rmSync(temporary,{recursive:true,force:true});
}
