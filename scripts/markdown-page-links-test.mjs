// Real import routes/action, sessions and SQLite; synthetic files and no outbound services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),root=path.resolve('src');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-markdown-page-links-'));
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
 const bundle=await imported([
  entry('export/README.md','# Root manual\n\nROOTMARK\n\n[Start](start.md)'),
  entry('export/start.md','# Entry heading\n\nSTARTMARK\n\n[Forward](b.md)\n\n[Draft](c.md)\n\n[Self](start.md?mode=read#top)\n\n[Root](README.md)\n\n[Guide](docs/README.md#intro)\n\n[Percent](space%20name.md?view=1#part)\n\n[Missing](missing.md)\n\n[External](https://example.test/b.md)\n\n[Anchor](#section)\n\n![Asset](assets/shared.png)\n\n```text\n[Code link](b.md)\n```\n\nLiteral b.md stays plain.\n\n| Link |\n| --- |\n| [Table](b.md) |\n\n- Parent\n  - [Nested](b.md)'),
  entry('export/b.md','# Shared title\n\nBMARK\n\n[Back](start.md)\n\n[Cycle](c.md)\n\n![Asset](assets/shared.png)'),
  entry('export/c.md','---\npublished: false\n---\n# Shared title\n\nCMARK\n\n[Cycle](b.md)'),
  entry('export/docs/child.md','# Child heading\n\nCHILDMARK\n\n[Parent](README.md)\n\n[Up](../start.md)'),
  entry('export/docs/README.md','# Docs guide\n\nGUIDEMARK\n\n[Child](child.md)'),
  entry('export/space name.md','# Different percent title\n\nPERCENTMARK'),
  entry('export/orphan-folder/child.md','# Nested child\n\nORPHANMARK'),
  entry('export/assets/shared.png','shared asset bytes'),
 ]);
 const find=marker=>{const page=bundle.pages.find(page=>page.content.includes(marker));assert.ok(page,marker);checks++;return page;};
 const start=find('STARTMARK'),b=find('BMARK'),c=find('CMARK'),rootPage=find('ROOTMARK'),guide=find('GUIDEMARK'),child=find('CHILDMARK'),percent=find('PERCENTMARK');
 const url=page=>'/'+bundle.space.slug+'/'+page.slug;
 const expectLink=(source,label,target,suffix='')=>{const href=links(source)[label];check(href,url(target)+suffix,label+' uses actual stored slug');const parsed=new URL(href,'http://localhost');check(data.getPageBySlug(bundle.space.id,parsed.pathname.split('/')[2]).id,target.id,'rewritten destination resolves to stored page');};
 expectLink(start,'Forward',b);expectLink(start,'Draft',c);expectLink(start,'Self',start,'?mode=read#top');expectLink(start,'Root',rootPage);expectLink(start,'Guide',guide,'#intro');expectLink(start,'Percent',percent,'?view=1#part');expectLink(start,'Table',b);expectLink(start,'Nested',b);expectLink(b,'Back',start);expectLink(b,'Cycle',c);expectLink(c,'Cycle',b);expectLink(rootPage,'Start',start);expectLink(child,'Parent',guide);expectLink(child,'Up',start);expectLink(guide,'Child',child);
 check(b.title,c.title,'duplicate titles preserved');assert.notEqual(b.slug,c.slug);checks++;assert.notEqual(start.slug,'start');checks++;
 check(links(start).Missing,'missing.md');check(links(start).External,'https://example.test/b.md');check(links(start).Anchor,'#section');assert.ok(start.content.includes('[Code link](b.md)'));checks++;assert.ok(start.content.includes('Literal b.md stays plain.'));checks++;
 check(c.published,0,'draft frontmatter retained');check(child.parent_id,guide.id,'README occupies actual folder holder');check(bundle.pages.filter(page=>page.title==='docs').length,0,'no leftover docs placeholder');check(bundle.pages.find(page=>page.title==='orphan folder').published,0,'unfilled folder remains draft');
 check(db.prepare('SELECT COUNT(*) n FROM uploads WHERE space_id=?').get(bundle.space.id).n,1,'page-link pass keeps asset deduplication');
 for(const page of bundle.pages){const indexed=db.prepare('SELECT title,body FROM pages_fts WHERE page_id=?').all(page.id);check(indexed,page.published?[{title:page.title,body:page.content_text}]:[],'search reflects final stored content/publication');}
 const idA='11111111111111111111111111111111',idB='22222222222222222222222222222222';
 const notion=await imported([
  entry('Notion/A '+idA+'.md','# Heading not filename A\n\nAMARK\n\n[Forward](B%20'+idB+'.md?view=1#part)\n\n![Picture](A%20'+idA+'/picture.png)\n\n```\n[Code](B%20'+idB+'.md)\n```'),
  entry('Notion/B '+idB+'.md','# Heading not filename B\n\nBMARK\n\n[Back](A%20'+idA+'.md)'),entry('Notion/A '+idA+'/picture.png','notion picture'),
 ]);
 const na=notion.pages.find(page=>page.content.includes('AMARK')),nb=notion.pages.find(page=>page.content.includes('BMARK'));
 check(links(na).Forward,'/'+notion.space.slug+'/'+nb.slug+'?view=1#part');check(links(nb).Back,'/'+notion.space.slug+'/'+na.slug);assert.ok(na.content.includes('/api/files/'));checks++;assert.ok(na.content.includes('[Code](B%20'+idB+'.md)'));checks++;check(db.prepare('SELECT COUNT(*) n FROM uploads WHERE space_id=?').get(notion.space.id).n,1);
 // Fail only final content save, after two-pass page creation and attachment copying.
 let sawCopiedFileBeforeFailure=false;const filesBeforeFailure=fs.readdirSync(database.UPLOADS_DIR).length;db.function('observe_final_save',()=>{sawCopiedFileBeforeFailure=fs.readdirSync(database.UPLOADS_DIR).length>filesBeforeFailure;return 1;});
 db.exec("CREATE TRIGGER synthetic_final_save_failure BEFORE UPDATE OF content ON pages WHEN NEW.content LIKE '%FINALFAIL%' BEGIN SELECT observe_final_save(); SELECT RAISE(ABORT,'synthetic final save failure'); END");
 const before=snapshot();const failed=await upload(request([entry('first.md','# First\n\n[Next](last.md)\n\n![Image](picture.png)'),entry('last.md','# Last\n\nFINALFAIL\n\n[Back](first.md)'),entry('picture.png','must rollback')]));check(failed.status,303);assert.ok(failed.headers.get('location').startsWith('/import?error='));checks++;check(snapshot(),before,'failed final save rolls back pages/files/reports');check(sawCopiedFileBeforeFailure,true,'rollback test fails after copying actual attachment bytes');db.exec('DROP TRIGGER synthetic_final_save_failure');
 console.log(`${checks} Markdown page-link functional checks passed (actual import route, isolated SQLite/files)`);
}finally{
 if(db?.open)db.close();delete globalThis.__octavoDb;
 Module._load=oldLoad;if(oldTs)Module._extensions['.ts']=oldTs;else delete Module._extensions['.ts'];if(oldTsx)Module._extensions['.tsx']=oldTsx;else delete Module._extensions['.tsx'];
 globalThis.fetch=oldFetch;console.error=oldError;fs.rmSync(temporary,{recursive:true,force:true});
}
