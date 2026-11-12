// Real import routes/action, sessions and SQLite; synthetic files and no outbound services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),root=path.resolve('src');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-review-next-'));
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
 db=load('lib/db.ts').getDb();
 const data=load('lib/data.ts'),roles=load('lib/roles.ts'),quality=load('lib/quality.ts'),revision=load('lib/quality-checks.ts').qualityRevision;
 const user={id:'owner',name:'Owner',email:'owner@example.test',role:'member'};
 db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(user.id,user.email,user.name,'!',user.role,Date.now());
 db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run('session-owner',user.id,Date.now()+86400000);
 cookie='session-owner';await load('lib/auth.ts').currentUser();
 const space=data.createSpace({name:'Review team',visibility:'private'});roles.setSpaceMember(space.id,user.id,'admin');
 const pages=[];for(let i=0;i<35;i++)pages.push(data.createPage({spaceId:space.id,title:'Target '+String(i).padStart(2,'0'),published:i%2===0,content:JSON.stringify([{type:'paragraph',content:[{type:'text',text:'Untouched body '+i,styles:{}}],children:[]}])}));
 const action=load('app/quality/actions.ts').qualityAction;
 const snapshot=()=>JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}"`).all()]));
 const pageSnapshot=()=>JSON.stringify(db.prepare('SELECT * FROM pages ORDER BY id').all());
 const reviewCount=()=>db.prepare('SELECT COUNT(*) AS n FROM document_reviews WHERE verified_at IS NOT NULL').get().n;
 const form=(page,values={})=>{const f=new FormData();for(const [key,value] of Object.entries({pageId:page.id,revision:revision(data.getPage(page.id)),operation:'verify',due:'2099-01-01',search:'Target',state:'all',owner:'all',queue:'1',...values}))f.set(({search:'queueSearch',state:'queueState',owner:'queueOwner',queue:'queuePage'})[key]??key,String(value));return f;};
 const run=async f=>{try{await action(f);assert.fail('Expected action redirect');}catch(error){if(!(error instanceof Redirect))throw error;return new URL(error.location,'http://localhost');}};
 const nav=load('lib/quality-navigation.ts');
 const ids=(...names)=>names.map(id=>({id}));
 check(nav.nextQualityDocument(ids('a','b','c'),ids('a','b','c'),'a'),{pageId:'b',queue:1});
 check(nav.nextQualityDocument(ids('a','b','c'),ids('a','b','c'),'c'),{pageId:'a',queue:1});
 check(nav.nextQualityDocument(ids('a','b','c'),ids('c','a'),'a'),{pageId:'c',queue:1});
 check(nav.nextQualityDocument(ids('a','b'),ids('a'),'a'),null);
 check(nav.nextQualityDocument(ids('a'),ids('a','new'),'a'),{pageId:'new',queue:1});
 check(nav.nextQualityDocument(ids('a','b'),ids('new','b','a'),'a'),{pageId:'b',queue:1},'retained old successor precedes newly matching rows');
 check(nav.nextQualityDocument(ids('a'),ids('b'),'missing'),null);
 const many=ids(...Array.from({length:65},(_,i)=>'id'+i));const originalMany=JSON.stringify(many);check(nav.nextQualityDocument(many,many,'id29'),{pageId:'id30',queue:2});check(nav.nextQualityDocument(many,many.filter(x=>x.id!=='id0'),'id29'),{pageId:'id30',queue:1},'queue index calculated after removal');check(JSON.stringify(many),originalMany,'pure navigation leaves arrays unchanged');
 check(nav.qualityNavigationContext(new FormData()),{filters:{search:'',state:'all',owner:'all'},queue:1});
 for(const values of [{queue:'0'},{queue:'1.5'},{queue:'NaN'},{state:'bad'},{owner:'bad'},{search:'x'.repeat(201)}]){assert.throws(()=>nav.qualityNavigationContext(form(pages[0],values)));checks++;}
 const duplicate=form(pages[0]);duplicate.append('queuePage','2');assert.throws(()=>nav.qualityNavigationContext(duplicate));checks++;
 const navHref=new URL(nav.qualityNavigationHref({filters:{search:'A & B',state:'changed',owner:'me'},queue:2},{pageId:'id?',saved:true,reviewed:true}),'http://localhost');check(navHref.pathname,'/quality');check(navHref.searchParams.get('search'),'A & B');check(navHref.searchParams.get('page'),'id?');
 const beforePages=pageSnapshot();
 let result=await run(form(pages[3],{operation:'assign',ownerId:'owner',state:'unreviewed',owner:'me',queue:'2'}));
 check(result.searchParams.get('page'),pages[3].id);check(result.searchParams.get('search'),'Target');check(result.searchParams.get('state'),'unreviewed');check(result.searchParams.get('owner'),'me');check(result.searchParams.get('queue'),'2');check(result.searchParams.get('saved'),'1');check(reviewCount(),0);
 result=await run(form(pages[3],{state:'unreviewed',owner:'me',queue:'2'}));check(result.searchParams.get('page'),pages[3].id,'ordinary verify stays on requested document');check(result.searchParams.get('queue'),'2');check(reviewCount(),1);check(pageSnapshot(),beforePages,'review and assignment leave all page bytes/publication/timestamps unchanged');
 const count=reviewCount();result=await run(form(pages[29],{advance:'1'}));check(result.searchParams.get('page'),pages[30].id);check(result.searchParams.get('queue'),'2','next page crosses 30-row boundary');check(reviewCount(),count+1);check(db.prepare('SELECT * FROM document_reviews WHERE page_id=?').get(pages[30].id),undefined,'next target not auto-verified');check(pageSnapshot(),beforePages);
 result=await run(form(pages[34],{advance:'1'}));check(result.searchParams.get('page'),pages[0].id,'wrap after last');check(result.searchParams.get('queue'),'1');
 const staleForm=form(pages[4],{advance:'1'});data.savePage(pages[4].id,{title:'Target 04 changed'});const staleBefore=snapshot();result=await run(staleForm);check(result.searchParams.get('page'),pages[4].id);assert.match(result.searchParams.get('error'),/Page changed/);checks++;check(result.searchParams.has('saved'),false);check(snapshot(),staleBefore,'stale revision fails without writes or advancing');
 // A currently narrowed queue has one remaining unreviewed item; completion is not all-status success.
 result=await run(form(pages[10],{search:'Target 10',state:'unreviewed',advance:'1'}));
 check(result.searchParams.get('completed'),'1');check(result.searchParams.get('page'),pages[10].id);const completed=result;check(result.searchParams.get('search'),'Target 10');check(quality.qualityPages(user).filter(p=>p.id===pages[10].id)[0].state,'verified');
 result=await run(form(pages[11],{search:'Target 11',advance:'1'}));check(result.searchParams.get('completed'),'1');check(result.searchParams.get('page'),pages[11].id);const noOther=result;
 assert.notEqual(completed.search,noOther.search);checks++;
 // Current scope is recomputed at action time, not captured by the form.
 const second=data.createSpace({name:'Review other',visibility:'private'});roles.setSpaceMember(second.id,user.id,'editor');const revoked=data.createPage({spaceId:second.id,title:'Target 99'});
 const revokedForm=form(revoked,{advance:'1'});roles.removeSpaceMember(second.id,user.id);const revokeBefore=snapshot();result=await run(revokedForm);assert.ok(result.searchParams.has('error'));checks++;check(result.searchParams.get('page'),revoked.id);check(snapshot(),revokeBefore);
 result=await run(form(pages[34],{advance:'1'}));check(result.searchParams.get('page'),pages[0].id,'unavailable next candidate excluded');
 // Out-of-filter selected item cannot silently navigate an unrelated queue.
 const noMatchBefore=snapshot();result=await run(form(pages[12],{search:'Nothing matches',advance:'1'}));check(result.searchParams.get('page'),pages[12].id);check(result.searchParams.has('error'),true);check(snapshot(),noMatchBefore);
 const invalidBefore=snapshot();result=await run(form(pages[13],{state:'invalid',advance:'1'}));check(result.searchParams.has('error'),true);check(snapshot(),invalidBefore,'invalid navigation context does not mutate');
 for(const values of [{operation:'assign',advance:'1',ownerId:'owner'},{advance:'yes'}]){const beforeInvalid=snapshot();result=await run(form(pages[18],values));check(result.searchParams.has('error'),true);check(snapshot(),beforeInvalid);}
 result=await run(form(pages[19],{operation:'reusable',enabled:'1',state:'unreviewed',owner:'unassigned',queue:'2'}));check(result.searchParams.get('state'),'unreviewed');check(result.searchParams.get('owner'),'unassigned');check(result.searchParams.get('queue'),'2');check(result.searchParams.get('page'),pages[19].id);check(result.searchParams.has('reviewed'),false);
 const noContext=form(pages[15],{advance:'1'});noContext.delete('queueOwner');const beforeMissing=snapshot();result=await run(noContext);check(result.searchParams.has('error'),true);check(snapshot(),beforeMissing);
 const legacy=form(pages[16]);for(const key of ['queueSearch','queueState','queueOwner','queuePage'])legacy.delete(key);result=await run(legacy);check(result.searchParams.get('saved'),'1');check(result.searchParams.get('page'),pages[16].id);check(result.searchParams.get('state'),'all');
 const cacheCount=reviewCount();cacheFails=true;result=await run(form(pages[17],{advance:'1'}));cacheFails=false;check(reviewCount(),cacheCount+1);check(result.searchParams.get('saved'),'1');check(result.searchParams.get('reviewed'),'1');assert.match(result.searchParams.get('error'),/Changes saved/);checks++;check(result.searchParams.get('page'),pages[17].id,'postcommit refresh failure keeps current page and honest saved notice');
 console.log(`${checks} review-next source checks passed (actual action/session/SQLite)`);
}finally{
 if(db?.open)db.close();delete globalThis.__octavoDb;
 Module._load=oldLoad;if(oldTs)Module._extensions['.ts']=oldTs;else delete Module._extensions['.ts'];if(oldTsx)Module._extensions['.tsx']=oldTsx;else delete Module._extensions['.tsx'];
 globalThis.fetch=oldFetch;console.error=oldError;fs.rmSync(temporary,{recursive:true,force:true});
}
