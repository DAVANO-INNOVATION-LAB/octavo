// Real import routes/action, sessions and SQLite; synthetic files and no outbound services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),root=path.resolve('src');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-markdown-index-collision-'));
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
 const data=load('lib/data.ts'),{zip}=load('lib/zip.ts'),upload=load('app/api/import/route.ts').POST;
 const {NextRequest}=require('next/server');
 const user={id:'owner',email:'owner@example.test',name:'Owner',role:'member'};
 db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(user.id,user.email,user.name,'!',user.role,Date.now());
 db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run('session-owner',user.id,Date.now()+86400000);cookie='session-owner';await load('lib/auth.ts').currentUser();
 const entry=(name,body)=>({name,data:Buffer.from(body)});
 const request=entries=>{const form=new FormData();form.set('file',new File([zip(entries)],'pages.zip'));return new NextRequest('http://localhost/api/import',{method:'POST',body:form});};
 const snapshot=()=>JSON.stringify([db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}"`).all()]),fs.readdirSync(database.UPLOADS_DIR).sort().map(name=>[name,fs.readFileSync(path.join(database.UPLOADS_DIR,name)).toString('hex')])]);
 const imported=async entries=>{const response=await upload(request(entries));check(response.status,303);const location=response.headers.get('location');assert.ok(!location.includes('?error='),location);const space=data.getSpaceBySlug(location.slice(1));assert.ok(space);checks++;return {space,pages:db.prepare('SELECT * FROM pages WHERE space_id=?').all(space.id)};};
 const links=page=>{const result={};const walk=value=>{if(Array.isArray(value))for(const item of value)walk(item);else if(value&&typeof value==='object'){if(value.type==='link')result[(value.content??[]).map(n=>n.text??'').join('')]=value.href;for(const child of Object.values(value))if(child&&typeof child==='object')walk(child);}};walk(JSON.parse(page.content));return result;};
 const specs=[
  {source:'index.md',marker:'ROOTPRIMARY',published:true},
  {source:'README.md',marker:'ROOTREADME',published:false},
  {source:'other.md',marker:'ROOTOTHER',published:true},
  {source:'docs/index.md',marker:'NESTPRIMARY',published:true},
  {source:'docs/README.md',marker:'NESTREADME',published:false},
  {source:'docs/child.md',marker:'NESTCHILD',published:true},
 ];
 const fixture=items=>items.map((item,i)=>entry('export/'+item.source,(item.published?'':'---\npublished: false\n---\n')+'# Same heading\n\n'+item.marker+'\n\n'+items.map((target,j)=>`[Link ${j}](${path.posix.relative(path.posix.dirname(item.source),target.source)}?from=${i}#section)`).join('\n\n')+`\n\n![Own asset](asset-${i}.png)\n\n[Shared asset](${path.posix.relative(path.posix.dirname(item.source),'shared.pdf')})`)).concat(items.map((item,i)=>entry('export/'+path.posix.join(path.posix.dirname(item.source),'asset-'+i+'.png'),'image '+i)),entry('export/shared.pdf','shared document'));
 const inspect=(result,items)=>{
  const mapped=items.map(item=>{const found=result.pages.filter(page=>page.content.includes(JSON.stringify(item.marker)));check(found.length,1,'each document body preserved exactly once');return found[0];});
  check(new Set(mapped.map(page=>page.id)).size,items.length,'distinct sources have distinct destinations');check(new Set(mapped.map(page=>page.slug)).size,items.length,'duplicate heading slugs unique');check(result.pages.length,items.length,'folder primary replaces placeholder without extra phantom pages');
  for(let i=0;i<items.length;i++){
   const page=mapped[i];check(page.published,items[i].published?1:0,'each document retains own publication');
   for(let j=0;j<items.length;j++){const href=links(page)['Link '+j];check(href,`/${result.space.slug}/${mapped[j].slug}?from=${i}#section`,'all exact source links resolve to distinct final page');check(data.getPageBySlug(result.space.id,new URL(href,'http://localhost').pathname.split('/')[2]).id,mapped[j].id);}
   check(db.prepare('SELECT title,body FROM pages_fts WHERE page_id=?').all(page.id),page.published?[{title:page.title,body:page.content_text}]:[],'FTS contains final content only for published page');
  }
  const uploads=db.prepare('SELECT name FROM uploads WHERE space_id=?').all(result.space.id);check(uploads.length,items.length+1,'all primary and secondary attachments retained with shared file dedupe');
  check(uploads.map(row=>fs.readFileSync(path.join(database.UPLOADS_DIR,row.name),'utf8')).sort(),[...items.map((_,i)=>'image '+i),'shared document'].sort());
  const report=load('lib/import-reports.ts').getImportReport(user,result.space.id);check(report.counts.pages,items.length);check(report.counts.attachmentsSaved,items.length+1);check(report.counts.drafts,items.filter(item=>!item.published).length);
  return mapped;
 };
 const normal=await imported(fixture(specs)),normalPages=inspect(normal,specs);
 check(normalPages[0].parent_id,null,'root index is primary');for(const index of [1,2,3])check(normalPages[index].parent_id,normalPages[0].id,'root secondary and nested primary belong under root primary');for(const index of [4,5])check(normalPages[index].parent_id,normalPages[3].id,'nested secondary README and child belong under nested primary');
 const reverse=await imported(fixture(specs).reverse()),reversePages=inspect(reverse,specs);
 const shape=pages=>pages.map(page=>({slug:page.slug,parent:page.parent_id?pages.find(parent=>parent.id===page.parent_id)?.slug:null,published:page.published}));check(shape(reversePages),shape(normalPages),'archive entry order cannot change final hierarchy or slugs');
 // Multiple case variants remain separate source documents, with one deterministic primary.
 const variants=[
  {source:'index.md',marker:'LOWERINDEX',published:true},{source:'INDEX.MD',marker:'UPPERINDEX',published:false},{source:'README.md',marker:'UPPERREADME',published:true},{source:'readme.md',marker:'LOWERREADME',published:true},
  {source:'sub/index.md',marker:'SUBLOWERINDEX',published:true},{source:'sub/INDEX.MD',marker:'SUBUPPERINDEX',published:true},{source:'sub/README.md',marker:'SUBREADME',published:false},
 ];
 const caseOne=await imported(fixture(variants)),caseOnePages=inspect(caseOne,variants);const caseTwo=await imported(fixture(variants).reverse()),caseTwoPages=inspect(caseTwo,variants);check(shape(caseTwoPages),shape(caseOnePages),'case tie behavior deterministic across archive order');
 const rootPrimaries=caseOnePages.filter(page=>page.parent_id===null);check(rootPrimaries.length,1,'one root primary among variants');const primaryPosition=caseOnePages.indexOf(rootPrimaries[0]);check(variants[primaryPosition].source,'index.md','canonical lowercase index wins case variants');
 const subIndices=[4,5],subPrimary=subIndices.find(i=>caseOnePages[i].parent_id===rootPrimaries[0].id);check(subPrimary,4,'nested canonical lowercase index wins case variants');for(const i of [4,5,6])if(i!==subPrimary)check(caseOnePages[i].parent_id,caseOnePages[subPrimary].id);
 // No index: README is the folder document and its children stay underneath it.
 const readmeSpecs=[{source:'README.md',marker:'ONLYREADME',published:true},{source:'child.md',marker:'ONLYCHILD',published:true}];const readme=await imported(fixture(readmeSpecs)),readmePages=inspect(readme,readmeSpecs);check(readmePages[0].parent_id,null);check(readmePages[1].parent_id,readmePages[0].id);
 let sawFiles=false;const beforeFiles=fs.readdirSync(database.UPLOADS_DIR).length;db.function('collision_failure_observer',()=>{sawFiles=fs.readdirSync(database.UPLOADS_DIR).length>beforeFiles;return 1;});
 db.exec("CREATE TRIGGER synthetic_collision_save_failure BEFORE UPDATE OF content ON pages WHEN NEW.content LIKE '%ROOTREADME%' BEGIN SELECT collision_failure_observer(); SELECT RAISE(ABORT,'synthetic secondary save failure'); END");
 const before=snapshot(),failed=await upload(request(fixture(specs)));check(failed.status,303);assert.ok(failed.headers.get('location').includes('/import?error='));checks++;check(sawFiles,true,'failure happens after copied attachments');check(snapshot(),before,'secondary final-save failure restores all pages, reports and bytes');db.exec('DROP TRIGGER synthetic_collision_save_failure');
 console.log(`${checks} Markdown index collision functional checks passed (actual import route, isolated SQLite/files)`);
}finally{
 if(db?.open)db.close();delete globalThis.__octavoDb;
 Module._load=oldLoad;if(oldTs)Module._extensions['.ts']=oldTs;else delete Module._extensions['.ts'];if(oldTsx)Module._extensions['.tsx']=oldTsx;else delete Module._extensions['.tsx'];
 globalThis.fetch=oldFetch;console.error=oldError;fs.rmSync(temporary,{recursive:true,force:true});
}
