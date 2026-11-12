// Real import routes/action, sessions and SQLite; synthetic files and no outbound services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),root=path.resolve('src');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-import-report-'));
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
try{
 const database=load('lib/db.ts');db=database.getDb();
 const data=load('lib/data.ts'),roles=load('lib/roles.ts'),tenants=load('lib/tenants.ts'),reports=load('lib/import-reports.ts');
 const upload=load('app/api/import/route.ts').POST,urlImport=load('app/api/import/url/route.ts').POST,openapi=load('app/actions.ts').importOpenApiAction;
 const reportGet=load('app/api/spaces/[slug]/import-report/route.ts').GET;
 const {NextRequest}=require('next/server');
 const users={};for(const id of ['owner','reader','outsider','admin','agent']){
  const role=id==='admin'?'admin':id==='agent'?'agent':'member';users[id]={id,name:id,email:id+'@example.test',role};
  db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id,users[id].email,id,'!',role,Date.now());
  db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run('session-'+id,id,Date.now()+86400000);
 }
 const login=id=>{cookie=id?'session-'+id:undefined;};login('owner');
 const snapshot=()=>JSON.stringify([db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}"`).all()]),fs.readdirSync(database.UPLOADS_DIR).sort().map(name=>[name,fs.readFileSync(path.join(database.UPLOADS_DIR,name)).toString('hex')])]);
 const uploadRequest=(name,body)=>{const form=new FormData();form.set('file',new File([body],name));return new NextRequest('http://localhost/api/import',{method:'POST',body:form});};
 const urlRequest=()=>new NextRequest('http://localhost/api/import/url',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:'https://synthetic.invalid/report.md'})});
 const spec=JSON.stringify({openapi:'3.0.3',info:{title:'Report API',version:'1'},paths:{'/health':{get:{summary:'Health',responses:{200:{description:'Healthy'}}}}}});
 const openapiForm=()=>{const form=new FormData();form.set('spec',spec);return form;};
 const callOpenapi=async()=>{try{await openapi(openapiForm());throw Error('Missing redirect');}catch(error){if(!(error instanceof Redirect))throw error;return error.location;}};
 const invocations=[
  ['upload',async()=>{const response=await upload(uploadRequest('report.md','# Report\n\nImported body'));check(response.status,303);return response.headers.get('location');}],
  ['url',async()=>{const response=await urlImport(urlRequest());check(response.status,200);return '/'+(await response.json()).spaceSlug;}],
  ['openapi',callOpenapi],
 ];
 const imported=[];
 for(const [kind,invoke] of invocations){const location=await invoke();const space=data.getSpaceBySlug(location.split('/')[1]);assert.ok(space,location);const report=reports.getImportReport(users.owner,space.id);assert.ok(report,kind);checks++;imported.push({kind,space,report});}
 const api=slug=>reportGet(new Request('http://localhost/api/spaces/'+slug+'/import-report'),{params:Promise.resolve({slug})});
 for(const {kind,space,report} of imported){
  check(report.source.kind,kind);check(report.actorId,'owner');assert.ok(report.completedAt>0);checks++;
  const pages=db.prepare('SELECT * FROM pages WHERE space_id=?').all(space.id);
  check(report.counts.pages,pages.length);check(report.counts.published,pages.filter(p=>p.published===1).length);check(report.counts.drafts,pages.filter(p=>p.published===0).length);check(report.counts.indexed,pages.filter(p=>p.published===1).length);check(report.counts.attachmentsSaved,0);assert.ok(report.notes.length);checks++;
  if(kind==='url')check(report.source.label,'synthetic.invalid');
  if(kind==='upload')check(report.preview.pages,1);
  const result=await api(space.slug);check(result.status,200);check(await result.json(),report);check(result.headers.get('cache-control'),'private, no-store');check(result.headers.get('vary'),'Cookie');
  data.savePage(pages[0].id,{title:'Edited after receipt',published:false});check(reports.getImportReport(users.owner,space.id),report,'completion snapshot survives edits');
 }
 const historical=data.createSpace({name:'Historical synthetic space'});roles.setSpaceMember(historical.id,'owner','admin');check(reports.getImportReport(users.owner,historical.id),null);check((await api(historical.slug)).status,404);
 assert.throws(()=>reports.createImportReport({spaceId:historical.id,actorId:'owner',sourceKind:'upload',sourceLabel:'history.md'}),/transaction/);checks++;
 // Shared Markdown ZIP plan includes generated folder pages in preview counts.
 const zip=load('lib/zip.ts').zip;
 const archive=zip([{name:'root.md',data:Buffer.from('# Root')},{name:'folder/page.md',data:Buffer.from('# Nested\n\n[Relative](other.md)')},{name:'image.png',data:Buffer.from('synthetic image')}]);
 const archiveResponse=await upload(uploadRequest('folders.zip',archive));const archiveSpace=data.getSpaceBySlug(archiveResponse.headers.get('location').split('/')[1]);assert.ok(archiveSpace);const archiveReport=reports.getImportReport(users.owner,archiveSpace.id);
 check(archiveReport.counts.pages,3);check(archiveReport.counts.drafts,1);check(archiveReport.counts.published,2);check(archiveReport.counts.attachmentsSaved,0);assert.equal(archiveReport.preview.pages,archiveReport.counts.pages);assert.ok(!archiveReport.warnings.some(w=>w.includes('Preview estimated')));checks++;assert.ok(archiveReport.warnings.some(w=>w.includes('relative')));checks++;
 const notebook=JSON.stringify({cells:[{cell_type:'code',source:['print(1)'],outputs:[{data:{'image/png':Buffer.from('synthetic notebook image').toString('base64')}}]}]});
 const notebookResponse=await upload(uploadRequest('report.ipynb',notebook));const notebookSpace=data.getSpaceBySlug(notebookResponse.headers.get('location').split('/')[1]);const notebookReport=reports.getImportReport(users.owner,notebookSpace.id);check(notebookReport.counts.attachmentsSaved,1);check(db.prepare('SELECT COUNT(*) n FROM uploads WHERE space_id=?').get(notebookSpace.id).n,1);
 // Failure writing the report rolls back content, index, ownership and newly created files.
 db.exec("CREATE TRIGGER synthetic_report_failure BEFORE INSERT ON import_reports BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
 for(const [kind,invoke] of invocations){const before=snapshot();if(kind==='url'){const response=await urlImport(urlRequest());check(response.status,400);}else if(kind==='upload'){const response=await upload(uploadRequest('failed.ipynb',notebook));assert.ok(response.headers.get('location').startsWith('/import?error='));checks++;}else{assert.ok((await invoke()).startsWith('/import/openapi?error='));checks++;}check(snapshot(),before,'receipt failure rolls back all import state');}
 db.exec('DROP TRIGGER synthetic_report_failure');
 db.exec("CREATE TRIGGER synthetic_content_failure BEFORE INSERT ON pages BEGIN SELECT RAISE(ABORT,'synthetic content failure'); END");
 for(const kind of ['upload','url','openapi']){const before=snapshot();if(kind==='upload')await upload(uploadRequest('failed.md','# Failed'));else if(kind==='url')await urlImport(urlRequest());else await callOpenapi();check(snapshot(),before,'content failure creates no report');}
 db.exec('DROP TRIGGER synthetic_content_failure');
 for(const kind of ['upload','url','openapi']){const before=db.prepare('SELECT COUNT(*) n FROM import_reports').get().n;cacheFails=true;forwardFails=true;if(kind==='upload')await upload(uploadRequest('committed.md','# Committed'));else if(kind==='url')check((await urlImport(urlRequest())).status,200);else await callOpenapi();cacheFails=false;forwardFails=false;check(db.prepare('SELECT COUNT(*) n FROM import_reports').get().n,before+1,'postcommit failure retains receipt');}
 const target=imported[0];roles.setSpaceMember(target.space.id,'reader','reader');roles.setSpaceMember(target.space.id,'agent','admin');
 for(const actor of [null,'owner','reader','outsider','admin','agent']){login(actor);const allowed=actor==='owner'||actor==='admin';check(!!reports.getImportReport(actor?users[actor]:null,target.space.id),allowed);const response=await api(target.space.slug);check(response.status,allowed?200:404);check(response.headers.get('cache-control'),'private, no-store');if(!allowed)check(await response.text(),'Not found');}
 const tenant=tenants.createTenant('Report tenant');tenants.setSpaceTenant(target.space.id,tenant.id);login('owner');check(reports.getImportReport(users.owner,target.space.id),null,'retained admin grant outside tenant denied');check((await api(target.space.slug)).status,404);tenants.addMember(tenant.id,'owner');check(!!reports.getImportReport(users.owner,target.space.id),true);roles.removeSpaceMember(target.space.id,'owner');check(reports.getImportReport(users.owner,target.space.id),null,'creator loses access after admin removal');check((await api(target.space.slug)).status,404);roles.setSpaceMember(target.space.id,'owner','admin');
 data.deleteSpace(target.space.id,'owner');for(const actor of ['owner','admin']){login(actor);check(reports.getImportReport(users[actor],target.space.id),null);check((await api(target.space.slug)).status,404);}check((await api('missing-space')).status,404);
 // Keep actor identity only in the nullable foreign key, so deletion cannot leave a redundant ID in the snapshot.
 db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run('deleted-importer','deleted@example.test','Deleted importer','!','member',Date.now());
 const erasedSpace=data.createSpace({name:'Erased report creator'});
 const erasedReport=db.transaction(()=>reports.createImportReport({spaceId:erasedSpace.id,actorId:'deleted-importer',sourceKind:'upload',sourceLabel:'erasure.md'}))();
 const stored=()=>db.prepare('SELECT actor_id,report_json FROM import_reports WHERE space_id=?').get(erasedSpace.id);
 check(stored().actor_id,'deleted-importer');check(JSON.parse(stored().report_json).actorId,null,'serialized payload contains no redundant creator identifier');
 check(reports.getImportReport(users.admin,erasedSpace.id).actorId,'deleted-importer','existing creator rehydrated from FK');
 const storedBefore=stored().report_json;
 db.prepare('DELETE FROM users WHERE id=?').run('deleted-importer');
 check(stored().actor_id,null,'creator deletion nulls FK');check(stored().report_json,storedBefore,'creator deletion preserves nonidentifying snapshot');
 check(stored().report_json.includes('deleted-importer'),false,'erased identifier not retained in JSON');
 check(reports.getImportReport(users.admin,erasedSpace.id),{...erasedReport,actorId:null},'report remains available without erased creator ID');
 login('admin');const erasedResponse=await api(erasedSpace.slug);check(erasedResponse.status,200);check((await erasedResponse.json()).actorId,null,'export does not restore erased identity');
 assert.ok(errors.length,'synthetic postcommit errors were exercised');checks++;
 console.log(`${checks} import-report checks passed (actual sessions, actions/routes, isolated SQLite)`);
}finally{
 if(db?.open)db.close();delete globalThis.__octavoDb;
 Module._load=oldLoad;if(oldTs)Module._extensions['.ts']=oldTs;else delete Module._extensions['.ts'];if(oldTsx)Module._extensions['.tsx']=oldTsx;else delete Module._extensions['.tsx'];
 globalThis.fetch=oldFetch;console.error=oldError;fs.rmSync(temporary,{recursive:true,force:true});
}
