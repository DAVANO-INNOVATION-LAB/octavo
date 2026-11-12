// Real import routes/action, sessions and SQLite; synthetic files and no outbound services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),root=path.resolve('src');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-markdown-import-plan-'));
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
 const {previewImport}=load('lib/import-preview.ts'),{zip}=load('lib/zip.ts'),data=load('lib/data.ts');
 const previewRoute=load('app/api/import/preview/route.ts').POST,upload=load('app/api/import/route.ts').POST;
 const {NextRequest}=require('next/server');
 const user={id:'owner',email:'owner@example.test',name:'Owner',role:'member'};
 db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(user.id,user.email,user.name,'!',user.role,Date.now());
 db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run('session-owner',user.id,Date.now()+86400000);cookie='session-owner';await load('lib/auth.ts').currentUser();
 const entry=(name,value)=>({name,data:Buffer.from(value)});
 const snapshot=()=>JSON.stringify([db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}"`).all()]),fs.readdirSync(database.UPLOADS_DIR).sort().map(name=>[name,fs.readFileSync(path.join(database.UPLOADS_DIR,name)).toString('hex')])]);
 const request=(name,bytes,digest)=>{const form=new FormData();form.set('file',new File([bytes],name));if(digest)form.set('previewDigest',digest);return new NextRequest('http://localhost/api/import',{method:'POST',body:form});};
 const bytesByDigest=new Map();
 const preview=async(name,bytes)=>{const before=snapshot();const direct=previewImport(name,bytes);check(snapshot(),before,'pure preview writes no rows/files');const response=await previewRoute(request(name,bytes));check(response.status,200);const result=await response.json();check(result,direct);check(snapshot(),before,'actual preview route writes no rows/files');check(result.errors,[]);bytesByDigest.set(result.digest,bytes);return result;};
 const fixture=[
  entry('export/index.md','# Root heading\n\nROOTBODY\n\n[Secondary](README.md)\n\n[Guide](docs/index.md)'),
  entry('export/README.md','---\ntitle: "Quoted root title"\npublished: false\n---\n# Ignored heading\n\nSECONDARYBODY\n\n![Root asset](assets/root.png)'),
  entry('export/docs/index.md','# Guide heading\n\nGUIDEBODY\n\n[Readme](README.md)\n\n[Deep](deep/leaf.md)'),
  entry('export/docs/README.md','# Secondary guide\n\nGUIDEREADMEBODY'),
  entry('export/docs/deep/leaf.md','---\ntitle: \'Quoted leaf title\'\n---\n# Leaf body heading\n\nLEAFBODY\n\n[Up](../index.md)\n\n![Shared](../../assets/root.png)'),
  entry('export/orphan/branch/leaf.md','# Orphan leaf\n\nORPHANBODY'),
  entry('export/assets/root.png','shared image'),entry('export/assets/unused.txt','not referenced'),
 ];
 const imported=async(entries,plan)=>{const response=await upload(request('bundle.zip',bytesByDigest.get(plan.digest),plan.digest));check(response.status,303);const location=response.headers.get('location');assert.ok(!location.includes('error='),location);const space=data.getSpaceBySlug(location.slice(1));assert.ok(space);checks++;return {space,pages:db.prepare('SELECT * FROM pages WHERE space_id=? ORDER BY position').all(space.id)};};
 const first=await preview('bundle.zip',zip(fixture));
 const created=await imported(fixture,first);
 const comparePlan=(plan,result)=>{
  check(plan.pages.length,result.pages.length,'preview and import count every generated/source page');
  for(const [index,node] of plan.pages.entries()){
   const page=result.pages.find(p=>p.title===node.title);assert.ok(page,node.title);checks++;
   check(page.published,Number(node.published),'preview publication matches stored state');check(JSON.parse(page.content).length,node.blocks,'prepared blocks counted accurately');
   if(node.parentIndex!==null){assert.ok(Number.isInteger(node.parentIndex)&&node.parentIndex<index,'parent appears before child');checks++;check(page.parent_id,result.pages.find(p=>p.title===plan.pages[node.parentIndex].title).id,'preview parent hierarchy matches actual parent IDs');}else check(page.parent_id,null);
   if(node.generated){check(node.published,false);check(node.blocks,0);check(Object.hasOwn(node,'sourcePath'),false);}else assert.ok(node.sourcePath);
   check(db.prepare('SELECT title,body FROM pages_fts WHERE page_id=?').all(page.id),page.published?[{title:page.title,body:page.content_text}]:[],'final index remains consistent');
  }
 };
 comparePlan(first,created);
 check(first.pages.filter(p=>p.generated).map(p=>p.title).sort(),['branch','deep','orphan']);
 check(first.pages.filter(p=>p.published).length,5);check(first.pages.filter(p=>!p.published).length,4);
 assert.ok(first.pages.some(p=>p.title==='Quoted root title'));checks++;assert.ok(first.pages.some(p=>p.title==='Quoted leaf title'));checks++;
 const beforePure=snapshot(),pure=load('lib/markdown-import-plan.ts').planMarkdownImport(fixture);check(snapshot(),beforePure,'shared pure planner writes no rows/files');
 check(pure.nodes.map(node=>({title:node.title,published:node.published,blocks:node.blocks.length,sourcePath:node.sourcePath})),first.pages.map(node=>({title:node.title,published:node.published,blocks:node.blocks,sourcePath:node.sourcePath})));
 const root=created.pages.find(p=>p.title==='Root heading'),guide=created.pages.find(p=>p.title==='Guide heading'),secondary=created.pages.find(p=>p.title==='Quoted root title');
 assert.ok(root.content.includes('/'+created.space.slug+'/'+guide.slug));checks++;assert.ok(root.content.includes('/'+created.space.slug+'/'+secondary.slug));checks++;
 assert.ok(secondary.content.includes('/api/files/'));checks++;

 check(first.pages.map(p=>p.title).sort(),created.pages.map(p=>p.title).sort(),'preview titles include actual generated folders and final document titles');
 check(first.assetPlan,{files:1,bytes:12});check(db.prepare('SELECT COUNT(*) n FROM uploads WHERE space_id=?').get(created.space.id).n,1);
 const reversed=await preview('bundle.zip',zip([...fixture].reverse()));check(reversed.pages,first.pages,'entry order does not change planned pages');check(reversed.assetPlan,first.assetPlan);
 const reversedCreated=await imported([...fixture].reverse(),reversed);
 const actualShape=pages=>pages.map(p=>({title:p.title,slug:p.slug,published:p.published,parent:p.parent_id?pages.find(parent=>parent.id===p.parent_id).title:null})).sort((a,b)=>a.slug.localeCompare(b.slug));check(actualShape(reversedCreated.pages),actualShape(created.pages));
 const notionId='11111111111111111111111111111111';
 const notionEntries=[entry('Export/Page '+notionId+'.md','# Actual Notion heading\n\nOwner: Avery\nStatus: Drafting\n\nNotion body\n\n![Image](Page%20'+notionId+'/image.png)'),entry('Export/Page '+notionId+'/image.png','notion bytes')];
 const notionPreview=await preview('notion.zip',zip(notionEntries)),notionCreated=await imported(notionEntries,notionPreview);comparePlan(notionPreview,notionCreated);check(notionPreview.pages.map(p=>p.title),notionCreated.pages.map(p=>p.title));check(notionPreview.pages[0].title,'Actual Notion heading');check(notionPreview.pages[0].blocks,JSON.parse(notionCreated.pages[0].content).length,'Notion property table counted exactly');assert.ok(notionCreated.pages[0].content.includes('Owner'));checks++;
 for(const [name,bytes] of [['plain.md',Buffer.from('# Generic standalone')],['manifest.json',Buffer.from(JSON.stringify({octavo:1,pages:[{title:'Manifest title',blocks:[]}]}))],['notebook.ipynb',Buffer.from(JSON.stringify({cells:[]}))]]){const result=previewImport(name,bytes);assert.ok(Array.isArray(result.pages));checks++;check(Object.hasOwn(result,'assetPlan'),false,'generic preview remains outside Markdown archive plan');check(result.pages.some(p=>Object.hasOwn(p,'parentIndex')||Object.hasOwn(p,'generated')||Object.hasOwn(p,'sourcePath')),false,'generic format preview shape remains unchanged');}
 // The shared preview uses the same trim/default title rules as persisted pages.
 const titleCases=[
  ['quoted padding','title: "  Foo  "','Foo'],
  ['quoted whitespace','title: "   "','Untitled'],
  ['empty quoted frontmatter','title: ""','Fallback heading'],
  ['JSON empty string',"title: '\"\"'",'Untitled'],
  ['number-looking title','title: 123','123'],
  ['boolean-looking title','title: true','true'],
  ['null-looking title','title: null','null'],
  ['object-looking title','title: {"value":1}','{"value":1}'],
 ];
 for(const [label,frontmatter,title] of titleCases){
  const entries=[entry('file.md','---\n'+frontmatter+'\n---\n# Fallback heading\n\nTitle fixture body')];
  const planned=await preview('title.zip',zip(entries)),actual=await imported(entries,planned);
  check(planned.pages[0].title,title,label+' planned final title');check(actual.pages[0].title,title,label+' stored final title');comparePlan(planned,actual);
 }
 const blankFolderEntries=[entry('root.md','# Root fixture\n\nRoot body'),entry('_/leaf.md','# Leaf fixture\n\nLeaf body')];
 const blankFolderPlan=await preview('folder.zip',zip(blankFolderEntries)),blankFolderActual=await imported(blankFolderEntries,blankFolderPlan);comparePlan(blankFolderPlan,blankFolderActual);check(blankFolderPlan.pages.find(p=>p.generated).title,'Untitled','blank normalized generated folder uses persisted default');
 const report=load('lib/import-reports.ts').getImportReport(user,created.space.id);check(report.preview.pages,created.pages.length);check(report.counts.pages,created.pages.length);check(report.warnings.some(w=>w.startsWith('Preview estimated')),false,'shared plan removes generated-folder count mismatch');
 db.exec("CREATE TRIGGER synthetic_plan_save_failure BEFORE UPDATE OF content ON pages WHEN NEW.content LIKE '%SECONDARYBODY%' BEGIN SELECT RAISE(ABORT,'synthetic plan save failure'); END");const before=snapshot();const failed=await upload(request('bundle.zip',bytesByDigest.get(first.digest),first.digest));check(failed.status,303);assert.ok(failed.headers.get('location').includes('error='));checks++;check(snapshot(),before,'planned import failure rolls back pages/files/report');db.exec('DROP TRIGGER synthetic_plan_save_failure');
 console.log(`${checks} shared Markdown import plan functional checks passed (actual routes, isolated SQLite/files)`);
}finally{
 if(db?.open)db.close();delete globalThis.__octavoDb;
 Module._load=oldLoad;if(oldTs)Module._extensions['.ts']=oldTs;else delete Module._extensions['.ts'];if(oldTsx)Module._extensions['.tsx']=oldTsx;else delete Module._extensions['.tsx'];
 globalThis.fetch=oldFetch;console.error=oldError;fs.rmSync(temporary,{recursive:true,force:true});
}
