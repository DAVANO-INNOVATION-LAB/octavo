// Real import routes/action, sessions and SQLite; synthetic files and no outbound services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),root=path.resolve('src');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-source-matches-'));
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
 const data=load('lib/data.ts'),roles=load('lib/roles.ts'),groups=load('lib/groups.ts'),tenants=load('lib/tenants.ts');
 const {findImportSourceMatches}=load('lib/import-source-matches.ts');
 const upload=load('app/api/import/route.ts').POST,preview=load('app/api/import/preview/route.ts').POST,{NextRequest}=require('next/server');
 const users={};for(const id of ['owner','other','reader','agent']){
  users[id]={id,name:id,email:id+'@example.test',role:id==='agent'?'agent':'member'};
  db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id,users[id].email,id,'!',users[id].role,Date.now());
  db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run('session-'+id,id,Date.now()+86400000);
 }
 const bytes=Buffer.from('# Same\n\nSynthetic byte source');
 const request=(filename='source.md',body=bytes)=>{const form=new FormData();form.set('file',new File([body],filename));return new NextRequest('http://localhost/api/import/preview',{method:'POST',body:form});};
 cookie='session-owner';const imported=await upload(request());const space=data.getSpaceBySlug(imported.headers.get('location').slice(1));assert.ok(space);
 const lookup=(user=users.owner,body=bytes)=>findImportSourceMatches(user,body);
 let result=lookup();check(result.status,'complete');check(result.candidates.length,1);check(result.candidates[0].spaceSlug,space.slug);
 const response=await preview(request('renamed.md'));check(response.status,200);check(response.headers.get('cache-control'),'private, no-store');check(response.headers.get('vary'),'Cookie');check((await response.json()).sourceMatches,result,'renaming file still matches original bytes');
 check(lookup(users.owner,Buffer.from('# Different')).candidates,[]);
 db.prepare('UPDATE pages SET content=? WHERE space_id=?').run('legitimate later edits',space.id);check(lookup().candidates,result.candidates,'current edits do not alter original-source match');
 roles.setSpaceMember(space.id,'reader','reader');check(lookup(users.reader).candidates,[]);check(lookup(users.other).candidates,[]);check(lookup(null).status,'unavailable');check(lookup(users.agent).status,'unavailable');
 const stored=db.prepare('SELECT * FROM import_reports WHERE space_id=?').get(space.id),original=stored.report_json;
 const set=value=>db.prepare('UPDATE import_reports SET report_json=? WHERE id=?').run(typeof value==='string'?value:JSON.stringify(value),stored.id);
 const snapshot=()=>JSON.stringify(db.prepare('SELECT * FROM import_reports ORDER BY id').all());const before=snapshot();lookup();check(snapshot(),before,'lookup is read-only');
 let baseline=JSON.parse(original);delete baseline.provenance;set(baseline);check(lookup().status,'complete');check(lookup().candidates,[],'legacy excluded');
 for(const mutate of [d=>{d.provenance.source.sha256='bad';},d=>{d.provenance.source.id='wrong';},d=>{d.provenance.schemaVersion=2;},d=>{d.id='wrong';},d=>{d.provenance.source.bytes=bytes.length+1;}]){const d=JSON.parse(original);mutate(d);set(d);check(lookup().candidates,[]);}
 set('{broken');check(lookup().status,'limited');set(' '.repeat(1024*1024+1));check(lookup().status,'limited');set(original);
 const badDate=JSON.parse(original);badDate.completedAt=9000000000000000;badDate.provenance.capturedAt=badDate.completedAt;set(badDate);db.prepare('UPDATE import_reports SET completed_at=? WHERE id=?').run(badDate.completedAt,stored.id);check(lookup().status,'limited');check(lookup().candidates,[]);db.prepare('UPDATE import_reports SET completed_at=? WHERE id=?').run(stored.completed_at,stored.id);set(original);
 roles.setSpaceMember(space.id,'owner','reader');check(lookup().candidates,[]);roles.setSpaceMember(space.id,'owner','admin');
 // A retained direct grant cannot cross a tenant boundary.
 const tenant=tenants.createTenant('Hidden tenant');tenants.setSpaceTenant(space.id,tenant.id);check(lookup().candidates,[]);tenants.setSpaceTenant(space.id,null);
 // Group admin is included, reader is not; explicit agent cap still wins.
 const group=groups.createGroup('Source admins');groups.addGroupMember(group.id,'other');
 db.prepare('INSERT INTO group_space_roles(group_id,space_id,role) VALUES(?,?,?)').run(group.id,space.id,'admin');check(lookup(users.other).candidates.length,1);roles.setSpaceMember(space.id,'other','agent');check(lookup(users.other).candidates,[]);
 // Hidden malformed/large receipts must not alter visible completeness or counts.
 for(let n=0;n<110;n++){const hidden=data.createSpace({name:'Hidden '+n,visibility:'private'});db.prepare('INSERT INTO import_reports(id,space_id,actor_id,completed_at,report_json) VALUES(?,?,?,?,?)').run('hidden-'+n,hidden.id,'other',Date.now()+n,'{malformed');}
 check(lookup().status,'complete');check(lookup().candidates.length,1);
 // Visible original-byte matches are capped without a hidden/global total.
 for(let n=0;n<11;n++){const copy=data.createSpace({name:'Matching '+n,visibility:'private'});roles.setSpaceMember(copy.id,'owner','admin');const d=JSON.parse(original);d.id='copy-'+n;d.spaceId=copy.id;d.completedAt=Date.now()+n;d.provenance.source.id=d.id;d.provenance.capturedAt=d.completedAt;db.prepare('INSERT INTO import_reports(id,space_id,actor_id,completed_at,report_json) VALUES(?,?,?,?,?)').run(d.id,copy.id,'owner',d.completedAt,JSON.stringify(d));}
 const limited=lookup();check(limited.status,'limited');check(limited.candidates.length,10);assert.ok(!JSON.stringify(limited).includes('hidden-'));checks++;
 // Metadata budget is applied to authorized receipts only, even without matches.
 for(let n=0;n<101;n++){const copy=data.createSpace({name:'Budget '+n,visibility:'private'});roles.setSpaceMember(copy.id,'owner','admin');const d=JSON.parse(original);d.id='budget-'+n;d.spaceId=copy.id;d.completedAt=Date.now()+1000+n;d.provenance.source.id=d.id;d.provenance.capturedAt=d.completedAt;d.provenance.source.sha256='0'.repeat(64);db.prepare('INSERT INTO import_reports(id,space_id,actor_id,completed_at,report_json) VALUES(?,?,?,?,?)').run(d.id,copy.id,'owner',d.completedAt,JSON.stringify(d));}
 check(lookup().status,'limited');check(lookup().candidates,[],'matches older than metadata budget are not falsely included');
 cookie='session-agent';check((await preview(request())).status,403);cookie=undefined;check((await preview(request())).status,403);
 console.log(`PASS import source matches: ${checks} checks`);
} finally {
 db?.close();Module._load=oldLoad;if(oldTs)Module._extensions['.ts']=oldTs;else delete Module._extensions['.ts'];if(oldTsx)Module._extensions['.tsx']=oldTsx;else delete Module._extensions['.tsx'];globalThis.fetch=oldFetch;console.error=oldError;fs.rmSync(temporary,{recursive:true,force:true});
}
