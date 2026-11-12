// Real import routes/action, sessions and SQLite; synthetic files and no outbound services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),root=path.resolve('src');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-markdown-assets-'));
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
 const data=load('lib/data.ts'),roles=load('lib/roles.ts'),tenants=load('lib/tenants.ts');
 const upload=load('app/api/import/route.ts').POST,fileGet=load('app/api/files/[name]/route.ts').GET;
 const {NextRequest}=require('next/server'),{zip}=load('lib/zip.ts');
 const users={};for(const id of ['owner','reader','outsider']){users[id]={id,name:id,email:id+'@example.test',role:'member'};db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id,users[id].email,id,'!','member',Date.now());db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run('session-'+id,id,Date.now()+86400000);}
 const login=id=>{cookie=id?'session-'+id:undefined;};login('owner');
 const entry=(name,bytes)=>({name,data:Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes)});
 const snapshot=()=>JSON.stringify([db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}"`).all()]),fs.readdirSync(database.UPLOADS_DIR).sort().map(name=>[name,fs.readFileSync(path.join(database.UPLOADS_DIR,name)).toString('hex')])]);
 const request=entries=>{const form=new FormData();form.set('file',new File([zip(entries)],'bundle.zip'));return new NextRequest('http://localhost/api/import',{method:'POST',body:form});};
 const imported=async entries=>{const response=await upload(request(entries));check(response.status,303);const location=response.headers.get('location');assert.ok(!location.includes('?error='),location);const space=data.getSpaceBySlug(location.slice(1));assert.ok(space);checks++;return {space,pages:db.prepare('SELECT * FROM pages WHERE space_id=?').all(space.id),uploads:db.prepare('SELECT * FROM uploads WHERE space_id=?').all(space.id)};};
 const referenceNames=text=>[...new Set([...text.matchAll(/\/api\/files\/([a-z0-9]+\.[a-z0-9]+)/g)].map(m=>m[1]))];
 const bytes=name=>fs.readFileSync(path.join(database.UPLOADS_DIR,name),'utf8');
 const get=async(name,actor)=>{login(actor);const response=await fileGet(new NextRequest('http://localhost/api/files/'+name),{params:Promise.resolve({name})});return new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers});};
 const bundle=await imported([
  entry('export/a/page.md','# First\n\n![First](image.png)\n\n[PDF](../shared/report%20file.pdf?download=1#page=2)\n\n![Again](image.png)\n\n[Missing](missing.pdf)\n\n[External](https://example.test/external.pdf)\n\n| Asset |\n| --- |\n| [Table PDF](../shared/report%20file.pdf) |\n\n- Parent\n  - [Nested PDF](../shared/report%20file.pdf)'),
  entry('export/b/page.md','# Second\n\n![Other](image.png)\n\n[Shared](../shared/report%20file.pdf)'),
  entry('export/a/image.png','image A'),entry('export/b/image.png','image B'),entry('export/shared/report file.pdf','shared PDF'),entry('export/unused.png','unused bytes'),
 ]);
 check(bundle.uploads.length,3,'only referenced assets are stored and shared asset is deduplicated');
 for(const row of bundle.uploads){check(row.uploaded_by,'owner');check(row.space_id,bundle.space.id);assert.match(row.name,/^[a-z0-9]+\.[a-z0-9]+$/);checks++;}
 const first=bundle.pages.find(page=>page.title==='First'),second=bundle.pages.find(page=>page.title==='Second');assert.ok(first&&second);
 const firstNames=referenceNames(first.content),secondNames=referenceNames(second.content);
 check(firstNames.map(bytes).sort(),['image A','shared PDF']);check(secondNames.map(bytes).sort(),['image B','shared PDF']);
 assert.ok(first.content.includes('?download=1#page=2'));checks++;assert.ok(first.content.includes('missing.pdf'));checks++;assert.ok(first.content.includes('https://example.test/external.pdf'));checks++;
 const report=load('lib/import-reports.ts').getImportReport(users.owner,bundle.space.id);check(report.counts.attachmentsSaved,3);
 const pdf=bundle.uploads.find(row=>bytes(row.name)==='shared PDF').name;
 roles.setSpaceMember(bundle.space.id,'reader','reader');
 for(const actor of [null,'owner','reader','outsider']){const response=await get(pdf,actor);check(response.status,actor==='owner'||actor==='reader'?200:404);if(response.status===200){check(await response.text(),'shared PDF');check(response.headers.get('cache-control'),'private, no-store');}else await response.text();}
 for(const page of bundle.pages)data.savePage(page.id,{published:false});check((await get(pdf,'reader')).status,404);check((await get(pdf,'owner')).status,200);
 data.savePage(first.id,{published:true});check((await get(pdf,'reader')).status,200);
 roles.removeSpaceMember(bundle.space.id,'owner');check((await get(pdf,'owner')).status,404,'origin ownership alone does not survive revocation');roles.setSpaceMember(bundle.space.id,'owner','admin');
 const tenant=tenants.createTenant('Asset tenant');tenants.setSpaceTenant(bundle.space.id,tenant.id);check((await get(pdf,'reader')).status,404);tenants.addMember(tenant.id,'reader');check((await get(pdf,'reader')).status,200);login('owner');
 // The original Notion export path, not cleaned title paths, determines asset resolution.
 const notion=await imported([entry('Export 11111111111111111111111111111111/Page 22222222222222222222222222222222.md','# Notion page\n\n![Notion](Page%2022222222222222222222222222222222/picture.png)\n\n[Other page](Other%2033333333333333333333333333333333.md?view=1#section)\n\n```text\n[Code link](Other%2033333333333333333333333333333333.md)\n![Code image](code-only.png)\n```'),entry('Export 11111111111111111111111111111111/Page 22222222222222222222222222222222/picture.png','notion image'),entry('Export 11111111111111111111111111111111/Other 33333333333333333333333333333333.md','# Other\n\nOther page content')]);
 check(notion.uploads.length,1);check(bytes(notion.uploads[0].name),'notion image');assert.ok(notion.pages.some(page=>page.content.includes('/'+notion.space.slug+'/other?view=1#section')),'Notion page links and suffixes still rewritten');checks++;assert.ok(notion.pages.some(page=>page.content.includes('/api/files/'+notion.uploads[0].name)));checks++;
 assert.ok(notion.pages.some(page=>page.content.includes('[Code link](Other%2033333333333333333333333333333333.md)')&&page.content.includes('![Code image](code-only.png)')),'Notion-like text inside code is not rewritten');checks++;
 // Pure planning and recursive URL fields cover block shapes not all produced by Markdown syntax.
 const {planMarkdownAssets,rewriteMarkdownAssets,MARKDOWN_ASSET_LIMITS}=load('lib/markdown-assets.ts');
 const transaction=load('lib/import-transaction.ts');
 const structured=[{type:'paragraph',content:[{type:'link',href:'asset.pdf?x=1#p',content:[{type:'text',text:'PDF'}]}],children:[{type:'file',props:{url:'asset.pdf'},children:[]}]},{type:'table',content:{type:'tableContent',rows:[{cells:[[{type:'link',href:'asset.pdf',content:[]}]]}]}},{type:'image',props:{url:'asset.pdf'},children:[]},{type:'paragraph',content:[{type:'text',text:'asset.pdf prose must not change'}]}];
 const original=JSON.stringify(structured),filesBefore=fs.readdirSync(database.UPLOADS_DIR).sort();
 const plan=planMarkdownAssets([entry('asset.pdf','structured PDF')],[{sourcePath:'page.md',blocks:structured}]);check(plan.assets.size,1);check(plan.bytes,14);check(JSON.stringify(structured),original,'planning leaves input blocks unchanged');check(fs.readdirSync(database.UPLOADS_DIR).sort(),filesBefore,'planning does not write files');
 let rewritten;transaction.runImportTransaction(()=>{rewritten=rewriteMarkdownAssets(structured,'page.md',plan);});
 check(JSON.stringify(structured),original,'rewrite clones source');check(referenceNames(JSON.stringify(rewritten)).length,1,'one generated asset reused in every field');check((JSON.stringify(rewritten).match(/\/api\/files\//g)||[]).length,4,'nested child, inline link, table and image rewritten');assert.ok(JSON.stringify(rewritten).includes('asset.pdf prose must not change'));checks++;
 const untouched=['missing.png','https://example.test/remote.png','//example.test/remote.png','/root.png','#anchor','mailto:a@example.test','data:image/png;base64,a','other.md','bad%ZZ.png'];
 const untouchedBlocks=untouched.map(url=>({type:'image',props:{url},children:[]}));
 const untouchedPlan=planMarkdownAssets([entry('other.md','# Other')],[{sourcePath:'page.md',blocks:untouchedBlocks}]);check(untouchedPlan.assets.size,0);check(rewriteMarkdownAssets(untouchedBlocks,'page.md',untouchedPlan),untouchedBlocks);
 const proseOnly=[{type:'codeBlock',content:[{type:'text',text:'![Code image](code-only.png) [Code link](asset.pdf)'}],children:[]},{type:'paragraph',content:[{type:'text',text:'Literal asset.pdf and Other 33333333333333333333333333333333.md'}],children:[]}];
 const prosePlan=planMarkdownAssets([entry('code-only.png','code-only bytes'),entry('asset.pdf','code-only PDF')],[{sourcePath:'page.md',blocks:proseOnly}]);check(prosePlan.assets.size,0,'literal prose and code never plan copied assets');check(rewriteMarkdownAssets(proseOnly,'page.md',prosePlan),proseOnly,'literal prose and code remain byte-equivalent');
 const ref=name=>[{sourcePath:'page.md',blocks:[{type:'file',props:{url:name},children:[]}]}];
 const oversized=Buffer.alloc(MARKDOWN_ASSET_LIMITS.perFile+1);assert.throws(()=>planMarkdownAssets([entry('large.bin',oversized)],ref('large.bin')),/20 MiB/);checks++;
 const unit=Buffer.alloc(MARKDOWN_ASSET_LIMITS.perFile);const totalEntries=Array.from({length:6},(_,i)=>entry('part'+i+'.bin',unit));assert.throws(()=>planMarkdownAssets(totalEntries,[{sourcePath:'page.md',blocks:totalEntries.map(e=>({type:'file',props:{url:e.name}}))}]),/100 MiB/);checks++;
 const many=Array.from({length:MARKDOWN_ASSET_LIMITS.files+1},(_,i)=>entry('asset'+i+'.png','a'));assert.throws(()=>planMarkdownAssets(many,[{sourcePath:'page.md',blocks:many.map(e=>({type:'image',props:{url:e.name}}))}]),/1000/);checks++;
 // Rejected imports must not retain rows, files, receipts or index entries.
 const denied=async entries=>{const before=snapshot();const response=await upload(request(entries));check(response.status,303);assert.ok(response.headers.get('location').startsWith('/import?error='));checks++;check(snapshot(),before,'rejection rolls back all bytes and rows');};
 await denied([entry('page.md','# Page\n\n![Image](image.png)'),entry('image.png','one'),entry('image.png','two')]);
 for(const name of ['../escape.png','/absolute.png','C:/drive.png','back\\slash.png','nul\0.png'])await denied([entry('page.md','# Page'),entry(name,'unsafe')]);
 for(const url of ['../escape.png','%2e%2e/escape.png','%2fabsolute.png','%5cback.png'])await denied([entry('page.md','# Page\n\n![Bad]('+url+')')]);
 await denied([entry('page.md','# Page\n\n![Image](large.bin)'),entry('large.bin',oversized)]);
 await denied([entry('page.md','# Page'),entry('asset.png','one'),entry('./asset.png','two')]);

 db.exec("CREATE TRIGGER synthetic_asset_receipt_failure BEFORE INSERT ON import_reports BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
 await denied([entry('page.md','# Rollback\n\n![Image](image.png)'),entry('image.png','rollback bytes')]);db.exec('DROP TRIGGER synthetic_asset_receipt_failure');
 db.exec("CREATE TRIGGER synthetic_asset_content_failure BEFORE INSERT ON pages BEGIN SELECT RAISE(ABORT,'synthetic content failure'); END");
 await denied([entry('page.md','# Rollback\n\n![Image](image.png)'),entry('image.png','rollback bytes')]);db.exec('DROP TRIGGER synthetic_asset_content_failure');
 console.log(`${checks} Markdown asset checks passed (actual routes/sessions, isolated SQLite and files)`);
}finally{
 if(db?.open)db.close();delete globalThis.__octavoDb;
 Module._load=oldLoad;if(oldTs)Module._extensions['.ts']=oldTs;else delete Module._extensions['.ts'];if(oldTsx)Module._extensions['.tsx']=oldTsx;else delete Module._extensions['.tsx'];
 globalThis.fetch=oldFetch;console.error=oldError;fs.rmSync(temporary,{recursive:true,force:true});
}
