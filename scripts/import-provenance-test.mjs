// Real import routes/action, sessions and SQLite; synthetic files and no outbound services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),root=path.resolve('src');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-provenance-'));
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
 const data=load('lib/data.ts'), roles=load('lib/roles.ts'), reports=load('lib/import-reports.ts');
 const {captureImportProvenance}=load('lib/import-provenance.ts');
 const upload=load('app/api/import/route.ts').POST, {NextRequest}=require('next/server');
 const hash=value=>require('node:crypto').createHash('sha256').update(value).digest('hex');
 const users={};for(const id of ['owner','reader','outsider']){
  users[id]={id,name:id,email:id+'@example.test',role:'member'};
  db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id,users[id].email,id,'!','member',Date.now());
  db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run('session-'+id,id,Date.now()+86400000);
 }
 cookie='session-owner';
 const importFile=async(name,body)=>{const form=new FormData();form.set('file',new File([body],name));return upload(new NextRequest('http://localhost/api/import',{method:'POST',body:form}));};
 const read=async(name,body)=>{const response=await importFile(name,body);check(response.status,303);const space=data.getSpaceBySlug(response.headers.get('location').slice(1));assert.ok(space,response.headers.get('location'));return {space,report:reports.getImportReport(users.owner,space.id)};};
 const body=Buffer.from('# Source\n\nProvenance 🪶 original body');
 const first=await read('source.md',body),second=await read('source.md',body);
 for(const {space,report} of [first,second]){
  const p=report.provenance;check(p.schemaVersion,1);check(p.source.id,report.id);check(p.source.sha256,hash(body));check(p.source.bytes,body.length);check(p.capturedAt,report.completedAt);check(p.converter.name,'octavo/importUpload');check(p.converter.version,load('lib/version.ts').VERSION);
  const pages=db.prepare('SELECT id,content FROM pages WHERE space_id=? ORDER BY id').all(space.id);check(p.pages,pages.map(x=>({pageId:x.id,contentSha256:hash(x.content)})));check(p.attachments,[]);
  const page=pages[0];data.savePage(page.id,{content:'changed later',title:'changed title'});check(reports.getImportReport(users.owner,space.id).provenance,p,'snapshot unchanged after edits');
  roles.setSpaceMember(space.id,'reader','reader');check(reports.getImportReport(users.reader,space.id),null);check(reports.getImportReport(users.outsider,space.id),null);check(reports.getImportReport(null,space.id),null);
 }
 assert.notEqual(first.report.provenance.source.id,second.report.provenance.source.id);checks++;check(first.report.provenance.source.sha256,second.report.provenance.source.sha256,'same bytes hash without a dedup lookup');
 const notebook=Buffer.from(JSON.stringify({cells:[{cell_type:'code',source:['print(1)'],outputs:[{data:{'image/png':Buffer.from('synthetic PNG').toString('base64')}}]}]}));
 const attached=await read('image.ipynb',notebook);check(attached.report.provenance.attachments.length,1);
 for(const item of attached.report.provenance.attachments){const bytes=fs.readFileSync(path.join(database.UPLOADS_DIR,item.name));check(item.bytes,bytes.length);check(item.sha256,hash(bytes));}
 const old=JSON.parse(db.prepare('SELECT report_json FROM import_reports WHERE id=?').get(first.report.id).report_json);delete old.provenance;
 db.prepare('UPDATE import_reports SET report_json=? WHERE id=?').run(JSON.stringify(old),first.report.id);check(reports.getImportReport(users.owner,first.space.id).provenance,undefined,'legacy remains unavailable');
 assert.throws(()=>captureImportProvenance({spaceId:first.space.id,receiptId:'synthetic',sourceBytes:body,capturedAt:1}),/transaction/);checks++;
 const item=attached.report.provenance.attachments[0],filename=path.join(database.UPLOADS_DIR,item.name),saved=fs.readFileSync(filename);
 fs.unlinkSync(filename);fs.symlinkSync(path.join(temporary,'octavo.db'),filename);
 assert.throws(()=>db.transaction(()=>captureImportProvenance({spaceId:attached.space.id,receiptId:'synthetic',sourceBytes:body,capturedAt:1}))(),/ELOOP|symbolic/i);checks++;
 fs.unlinkSync(filename);fs.writeFileSync(filename,saved);
 const capture=()=>captureImportProvenance({spaceId:attached.space.id,receiptId:'synthetic',sourceBytes:body,capturedAt:1});
 fs.truncateSync(filename,513*1024*1024);
 assert.throws(()=>db.transaction(capture)(),/size limit/);checks++;
 fs.writeFileSync(filename,saved);
 assert.throws(()=>db.transaction(()=>{db.prepare('INSERT INTO uploads(name,uploaded_by,space_id,created_at) VALUES(?,?,?,?)').run('../escape','owner',attached.space.id,Date.now());capture();})(),/Invalid.*name/);checks++;
 assert.throws(()=>db.transaction(()=>{for(let n=0;n<10001;n++)db.prepare('INSERT INTO uploads(name,uploaded_by,space_id,created_at) VALUES(?,?,?,?)').run('bounded-'+n,'owner',attached.space.id,Date.now());capture();})(),/item limit/);checks++;
 // Failure during provenance read must roll back the full upload and newly created assets.
 const snapshot=()=>JSON.stringify([db.prepare('SELECT id FROM spaces ORDER BY id').all(),db.prepare('SELECT id FROM pages ORDER BY id').all(),db.prepare('SELECT id FROM import_reports ORDER BY id').all(),db.prepare('SELECT name FROM uploads ORDER BY name').all(),fs.readdirSync(database.UPLOADS_DIR).sort()]);
 const before=snapshot(),originalRead=fs.readSync;
 fs.readSync=function(fd,...args){if(fs.fstatSync(fd).size===Buffer.byteLength('synthetic PNG'))throw Error('synthetic fingerprint failure');return originalRead.call(this,fd,...args);};
 try {const response=await importFile('fail.ipynb',notebook);assert.match(decodeURIComponent(response.headers.get('location')),/synthetic fingerprint failure/);checks++;} finally {fs.readSync=originalRead;}
 check(snapshot(),before,'fingerprint failure rolls back all imported state');
 console.log(`PASS upload provenance: ${checks} checks`);
} finally {
 db?.close();Module._load=oldLoad;
 if(oldTs)Module._extensions['.ts']=oldTs;else delete Module._extensions['.ts'];
 if(oldTsx)Module._extensions['.tsx']=oldTsx;else delete Module._extensions['.tsx'];
 globalThis.fetch=oldFetch;console.error=oldError;fs.rmSync(temporary,{recursive:true,force:true});
}
