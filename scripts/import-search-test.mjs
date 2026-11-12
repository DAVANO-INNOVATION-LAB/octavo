// Actual import routes/action and search route, synthetic SQLite only. URL fetch is stubbed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),root=path.resolve('src'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-import-search-'));
process.env.OCTAVO_DATA_DIR=dir;
const outsider={id:'outsider',name:'Outsider',email:'outsider@example.test',role:'member'};
const owner={id:'importer',name:'Importer',email:'importer@example.test',role:'member'};
let user=owner,db,checks=0;const failures=[];
const originalLoad=Module._load,originalTs=Module._extensions['.ts'],originalFetch=globalThis.fetch;
class Redirect extends Error {constructor(location){super('NEXT_REDIRECT');this.location=location;}}
Module._load=function(name,parent,main){
 if(name==='server-only')return {};
 if(name==='next/navigation')return {redirect:location=>{throw new Redirect(location);}};
 if(name==='next/cache')return {revalidatePath:()=>{}};
 if(name==='next/headers')return {cookies:async()=>({get:()=>undefined}),headers:async()=>new Map()};
 if(name==='@/lib/auth')return {currentUser:async()=>user};
 if(name==='./audit-forward')return {forwardAudit:()=>{}};
 if(name==='@/lib/import-url')return {fetchGuarded:async()=>({body:'# Urltitlemarker\n\nUrlbodymarker synthetic prose.',contentType:'text/markdown',finalUrl:'https://example.test/fixture.md'})};
 if(name.startsWith('@/'))name=path.join(root,name.slice(2));
 return originalLoad.call(this,name,parent,main);
};
Module._extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
globalThis.fetch=()=>{throw Error('External network prohibited by fixture');};
const load=n=>require(path.join(root,n));
const check=(message,test)=>{checks++;try{assert.ok(test,message);}catch(e){failures.push(e.message);}};
try{
 db=load('lib/db.ts').getDb();const data=load('lib/data.ts'),{NextRequest}=require('next/server'),{zip}=load('lib/zip.ts');
 db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(owner.id,owner.email,owner.name,'!',owner.role,Date.now());
 const upload=load('app/api/import/route.ts').POST,url=load('app/api/import/url/route.ts').POST,openapi=load('app/actions.ts').importOpenApiAction,search=load('app/api/search/route.ts').GET;
 const uploadFile=async(name,bytes)=>{const f=new FormData();f.set('file',new File([bytes],name));return decodeURIComponent((await upload({headers:new Headers(),formData:async()=>f})).headers.get('location'));};
 const apiForm=()=>{const f=new FormData();f.set('spec',JSON.stringify({openapi:'3.0.3',info:{title:'Apititlemarker',version:'1.0',description:'Apibodymarker documentation'},paths:{'/widgets':{get:{summary:'Operationtitlemarker',description:'Operationbodymarker endpoint documentation',responses:{200:{description:'Success'}}}}}}));return f;};
 const invokeApi=async()=>{try{await openapi(apiForm());throw Error('Expected redirect');}catch(e){if(!(e instanceof Redirect))throw e;return e.location;}};
 db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(outsider.id,outsider.email,outsider.name,'!',outsider.role,Date.now());
 const tenants=load('lib/tenants.ts'),tenant=tenants.createTenant('Synthetic search tenant');tenants.addMember(tenant.id,owner.id);
 const cases=[
  ['Markdown',()=>uploadFile('Uploadtitlemarker.md','# Uploadtitlemarker\n\nUploadbodymarker synthetic prose.'),['Uploadtitlemarker','Uploadbodymarker']],
  ['URL',async()=>{const r=await url({json:async()=>({url:'https://example.test/fixture.md',name:'Urltitlemarker'})});assert.equal(r.status,200);return '/'+(await r.json()).spaceSlug;},['Urltitlemarker','Urlbodymarker']],
  ['Notebook',()=>uploadFile('Notebooktitlemarker.ipynb',JSON.stringify({cells:[{cell_type:'markdown',source:['Notebookbodymarker prose']}]})),['Notebooktitlemarker','Notebookbodymarker']],
  ['Manifest',()=>uploadFile('fixture.zip',zip([{name:'octavo.json',data:Buffer.from(JSON.stringify({octavo:1,space:{name:'Manifest fixture'},pages:[{id:'one',parentId:null,position:1,title:'Manifesttitlemarker',published:true,blocks:[{id:'p',type:'paragraph',content:[{type:'text',text:'Manifestbodymarker prose',styles:{}}],children:[]}]}]}))}])),['Manifesttitlemarker','Manifestbodymarker']],
  ['Confluence HTML',()=>uploadFile('html.zip',zip([{name:'first.html',data:Buffer.from('<html><title>Htmltitlemarker</title><div id="main-content"><p>Htmlbodymarker prose</p></div></html>')}])),['Htmltitlemarker','Htmlbodymarker']],
  ['Confluence XML',()=>uploadFile('xml.zip',zip([{name:'entities.xml',data:Buffer.from('<hibernate-generic><object class="Space"><id name="id">1</id><property name="name">XML fixture</property><property name="key">XML</property></object><object class="Page"><id name="id">2</id><property name="title">Xmltitlemarker</property><property name="space"><id name="id">1</id></property></object><object class="BodyContent"><id name="id">3</id><property name="content"><id name="id">2</id></property><property name="body"><![CDATA[<p>Xmlbodymarker prose</p>]]></property></object></hibernate-generic>')}])),['Xmltitlemarker','Xmlbodymarker']],
  ['OpenAPI',invokeApi,['Operationtitlemarker','Apibodymarker','Overview','Operationbodymarker']],
 ];
 for(const [label,invoke,terms] of cases){
  user=owner;const location=await invoke();assert.ok(!location.includes('error='),location);const space=data.getSpaceBySlug(location.slice(1));assert.ok(space,label);
  if(label==='OpenAPI'){
   const stored=db.prepare('SELECT title,content_text FROM pages WHERE space_id=?').all(space.id);
   check('OpenAPI persisted overview uses generated title',stored.some(p=>p.title==='Overview'&&p.content_text.includes('Apibodymarker')));
   check('OpenAPI persisted operation has distinct title/body',stored.some(p=>p.title==='Operationtitlemarker'&&p.content_text.includes('Operationbodymarker')));
  }
  const pages=db.prepare('SELECT id,published FROM pages WHERE space_id=?').all(space.id);check(label+' creates published pages',pages.length&&pages.every(p=>p.published));
  for(const p of pages)check(label+' indexes published page '+p.id,!!db.prepare('SELECT 1 FROM pages_fts WHERE page_id=?').get(p.id));
  for(const term of terms){const request=()=>new NextRequest('http://localhost/api/search?q='+encodeURIComponent(term));const results=(await (await search(request())).json()).results;check(label+' creator finds '+term,results.some(r=>r.space_slug===space.slug));user=null;const hidden=(await (await search(request())).json()).results;check(label+' remains private '+term,hidden.length===0);user=outsider;check(label+' outsider cannot search '+term,(await (await search(request())).json()).results.length===0);user=owner;}
  // Tenant-public search still requires membership, not merely public visibility.
  tenants.setSpaceTenant(space.id,tenant.id);db.prepare("UPDATE spaces SET visibility='public' WHERE id=?").run(space.id);
  const request=()=>new NextRequest('http://localhost/api/search?q='+encodeURIComponent(terms[0]));
  check(label+' tenant member finds imported title',(await (await search(request())).json()).results.some(r=>r.space_slug===space.slug));user=outsider;check(label+' tenant outsider cannot search',(await (await search(request())).json()).results.length===0);user=null;check(label+' tenant anonymous cannot search',(await (await search(request())).json()).results.length===0);user=owner;
 }
 // Existing governed destinations keep generated OpenAPI pages as drafts.
 const governed=data.createSpace({name:'Governed import destination',visibility:'public'});
 db.prepare('INSERT INTO quality_policies(space_id,policy) VALUES(?,?)').run(governed.id,JSON.stringify({required:['Approval'],review:false,approval:false,links:false}));
 load('lib/openapi-pages.ts').importInto(governed.id,apiForm().get('spec'),data.createPage);
 const governedPages=db.prepare('SELECT id,published FROM pages WHERE space_id=?').all(governed.id);
 check('governed import remains draft',governedPages.length>0&&governedPages.every(p=>p.published===0));check('governed import stays unindexed',governedPages.every(p=>!db.prepare('SELECT 1 FROM pages_fts WHERE page_id=?').get(p.id)));

 // Search must reject stale indexed drafts even if an index row survives.
 const stale=data.createPage({spaceId:governed.id,title:'Staledraftmarker',content:'[]'});
 db.prepare('INSERT INTO pages_fts(page_id,title,body) VALUES(?,?,?)').run(stale.id,'Staledraftmarker','Staledraftbodymarker');
 for(const term of ['Staledraftmarker','Staledraftbodymarker'])check('stale draft FTS row cannot surface '+term,(await (await search(new NextRequest('http://localhost/api/search?q='+term))).json()).results.length===0);
 // Upload ownership follows parsing/indexing; a failed grant rolls both back.
 for(const [label,invoke] of cases.filter(c=>!['URL','OpenAPI'].includes(c[0]))){
  const snapshot=()=>JSON.stringify(['spaces','pages','pages_fts','space_members'].map(t=>db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));const before=snapshot();
  db.exec("CREATE TEMP TRIGGER fail_search_upload BEFORE INSERT ON space_members BEGIN SELECT RAISE(ABORT,'synthetic ownership failure'); END");
  try{assert.match(await invoke(),/error=/);check(label+' failed ownership rolls back FTS and content',snapshot()===before);}finally{db.exec('DROP TRIGGER fail_search_upload');}
 }
 // A late audit failure must roll back content AND any newly created FTS entries.
 for(const [label,invoke] of cases.filter(c=>['URL','OpenAPI'].includes(c[0]))){
  const snapshot=()=>JSON.stringify(['spaces','pages','pages_fts','audit_log','space_members'].map(t=>db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));const before=snapshot();
  db.exec("CREATE TEMP TRIGGER fail_search_import BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  try{if(label==='URL'){const r=await url({json:async()=>({url:'https://example.test/fixture.md'})});assert.equal(r.status,400);}else assert.match(await invoke(),/error=/);check(label+' rollback retains identical FTS and content',snapshot()===before);}finally{db.exec('DROP TRIGGER fail_search_import');}
 }
 console.log(`${checks-failures.length}/${checks} import search checks passed`);for(const failure of failures)console.error('FAIL '+failure);assert.equal(failures.length,0,'Import search regressions');
}finally{Module._load=originalLoad;Module._extensions['.ts']=originalTs;globalThis.fetch=originalFetch;if(db?.open)db.close();delete globalThis.__octavoDb;fs.rmSync(dir,{recursive:true,force:true});}
