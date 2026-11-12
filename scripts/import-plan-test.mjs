// Real import routes/action, sessions and SQLite; synthetic files and no outbound services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),root=path.resolve('src');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-import-plan-'));
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
 const {previewImport}=load('lib/import-preview.ts'),{zip}=load('lib/zip.ts'),data=load('lib/data.ts'),reports=load('lib/import-reports.ts');
 const previewRoute=load('app/api/import/preview/route.ts').POST,upload=load('app/api/import/route.ts').POST;
 const {NextRequest}=require('next/server');
 const user={id:'owner',email:'owner@example.test',name:'Owner',role:'member'};
 db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(user.id,user.email,user.name,'!',user.role,Date.now());
 db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run('session-owner',user.id,Date.now()+86400000);cookie='session-owner';await load('lib/auth.ts').currentUser();
 const entry=(name,value)=>({name,data:Buffer.from(value)});
 const snapshot=()=>JSON.stringify([db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}"`).all()]),fs.readdirSync(database.UPLOADS_DIR).sort().map(name=>[name,fs.readFileSync(path.join(database.UPLOADS_DIR,name)).toString('hex')])]);
 const request=(name,bytes,digest)=>{const form=new FormData();form.set('file',new File([bytes],name));if(digest)form.set('previewDigest',digest);return new NextRequest('http://localhost/api/import',{method:'POST',body:form});};
 const unchangedPreview=async(name,bytes)=>{
  const before=snapshot(),direct=previewImport(name,bytes);check(snapshot(),before,'pure preview changes no rows or files');
  const response=await previewRoute(request(name,bytes));check(response.status,200);const throughRoute=await response.json();const {sourceMatches,...routePlan}=throughRoute;check(routePlan,direct,'actual preview route preserves plan');assert.ok(['complete','limited','unavailable'].includes(sourceMatches.status));assert.ok(Array.isArray(sourceMatches.candidates));checks+=2;check(snapshot(),before,'route preview changes no rows or files');return direct;
 };
 const bytes=zip([
  entry('root/first.md','# First\n\n[Same](assets/report.txt)\n\n[Again](assets/report.txt?download=1#section)\n\n![Missing](missing.png)\n\n[External](https://example.test/file.png)'),
  entry('root/second.md','# Second\n\n[Shared](assets/report.txt)\n\n![Image](assets/image.png)'),
  entry('root/assets/report.txt','é界🙂'),entry('root/assets/image.png','image bytes'),entry('root/assets/unused.png','unreferenced'),
 ]);
 const preview=await unchangedPreview('bundle.zip',bytes);
 const expected={files:2,bytes:Buffer.byteLength('é界🙂')+Buffer.byteLength('image bytes')};
 check(preview.assetPlan,expected,'plan counts distinct referenced files and UTF-8 bytes');check(preview.attachments,3,'archive entries remain distinct from copy plan');
 const success=await upload(request('bundle.zip',bytes,preview.digest));check(success.status,303);const space=data.getSpaceBySlug(success.headers.get('location').slice(1));assert.ok(space);checks++;
 const report=reports.getImportReport(user,space.id);check(report.preview.assetPlan,expected);check(report.preview.attachmentEntries,3);check(report.counts.attachmentsSaved,2,'saved count separately records actual writes');
 check(db.prepare('SELECT COUNT(*) n FROM uploads WHERE space_id=?').get(space.id).n,2);
 const storedNames=db.prepare('SELECT name FROM uploads WHERE space_id=?').all(space.id);check(storedNames.reduce((n,row)=>n+fs.statSync(path.join(database.UPLOADS_DIR,row.name)).size,0),expected.bytes);
 const beforeMismatch=snapshot();const mismatch=await upload(request('bundle.zip',zip([entry('changed.md','# Changed')]),preview.digest));check(mismatch.status,303);assert.ok(mismatch.headers.get('location').includes('error='));checks++;check(snapshot(),beforeMismatch,'changed file digest creates no content, report or file');
 const zero=await unchangedPreview('unreferenced.zip',zip([entry('page.md','# Text only'),entry('unused.png','unused')]));check(zero.assetPlan,{files:0,bytes:0},'genuine empty plan is present, not omitted');check(zero.attachments,1);
 const notionId='22222222222222222222222222222222';
 const notion=await unchangedPreview('notion.zip',zip([entry('Export/Page '+notionId+'.md','# Notion\n\n![Image](Page%20'+notionId+'/photo.png)'),entry('Export/Page '+notionId+'/photo.png','notion bytes')]));check(notion.assetPlan,{files:1,bytes:12});
 const zeroBytes=zip([entry('page.md','# Text only'),entry('unused.png','unused')]);const zeroResponse=await upload(request('unreferenced.zip',zeroBytes,zero.digest));const zeroSpace=data.getSpaceBySlug(zeroResponse.headers.get('location').slice(1));check(reports.getImportReport(user,zeroSpace.id).preview.assetPlan,{files:0,bytes:0});check(reports.getImportReport(user,zeroSpace.id).counts.attachmentsSaved,0);
 const manifest=JSON.stringify({octavo:1,pages:[{title:'Manifest',blocks:[]}]});
 const confluenceXml='<hibernate-generic><object class="Space"><id name="id">1</id><property name="name">XML preview</property><property name="key">XML</property></object><object class="Page"><id name="id">2</id><property name="title">XML page</property></object><object class="BodyContent"><id name="id">3</id><property name="content"><id name="id">2</id></property><property name="body"><![CDATA[<p>XML body</p>]]></property></object></hibernate-generic>';
 const cases=[['confluence-xml.zip',zip([entry('entities.xml',confluenceXml)])],
  ['manifest.json',Buffer.from(manifest)],['manifest.zip',zip([entry('octavo.json',manifest),entry('image.png','not a Markdown plan')])],
  ['standalone.md',Buffer.from('# Markdown\n\n![Image](image.png)')],['standalone.txt',Buffer.from('plain text')],
  ['notebook.ipynb',Buffer.from(JSON.stringify({cells:[{cell_type:'markdown',source:['# Notebook']}]}))],
  ['word.docx',zip([entry('word/document.xml','<w:document><w:p><w:r><w:t>Word text</w:t></w:r></w:p></w:document>')])],
  ['confluence.zip',zip([entry('index.html','<html><title>Confluence</title><div id="main-content"><p>Confluence body</p></div></html>'),entry('attachments/image.png','asset')])],
 ];
 for(const [name,value] of cases){const result=await unchangedPreview(name,value);check(Object.hasOwn(result,'assetPlan'),false,name+' does not imply a Markdown asset plan');}
 // Historical reports without the optional property remain readable, with no inferred zero.
 const historical=data.createSpace({name:'Historical report'});load('lib/roles.ts').setSpaceMember(historical.id,user.id,'admin');
 const oldReport=db.transaction(()=>reports.createImportReport({spaceId:historical.id,actorId:user.id,sourceKind:'upload',sourceLabel:'old.md',preview:{pages:1,attachmentEntries:4}}))();
 check(Object.hasOwn(oldReport.preview,'assetPlan'),false);check(reports.getImportReport(user,historical.id),oldReport,'legacy snapshot stays unchanged');
 const urlSpace=data.createSpace({name:'URL report without preview'});load('lib/roles.ts').setSpaceMember(urlSpace.id,user.id,'admin');
 const urlReport=db.transaction(()=>reports.createImportReport({spaceId:urlSpace.id,actorId:user.id,sourceKind:'url',sourceLabel:'https://example.test/source'}))();check(urlReport.preview,null);
 console.log(`${checks} import copy-plan checks passed (actual preview/import routes, sessions, isolated SQLite)`);
}finally{
 if(db?.open)db.close();delete globalThis.__octavoDb;
 Module._load=oldLoad;if(oldTs)Module._extensions['.ts']=oldTs;else delete Module._extensions['.ts'];if(oldTsx)Module._extensions['.tsx']=oldTsx;else delete Module._extensions['.tsx'];
 globalThis.fetch=oldFetch;console.error=oldError;fs.rmSync(temporary,{recursive:true,force:true});
}
