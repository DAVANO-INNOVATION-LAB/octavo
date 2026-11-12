// Real import routes/action, sessions and SQLite; synthetic files and no outbound services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),root=path.resolve('src');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-quality-queue-'));
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
 const data=load('lib/data.ts'),roles=load('lib/roles.ts'),quality=load('lib/quality.ts'),checksModule=load('lib/quality-checks.ts');
 const users={};for(const id of ['owner','other','reader','agent']){const role=id==='agent'?'agent':'member';users[id]={id,name:id,email:id+'@example.test',role};db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id,users[id].email,id,'!',role,Date.now());db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run('session-'+id,id,Date.now()+86400000);}
 cookie='session-owner';await load('lib/auth.ts').currentUser();
 const alpha=data.createSpace({name:'Alpha platform',visibility:'private'}),beta=data.createSpace({name:'Beta science',visibility:'private'}),unavailable=data.createSpace({name:'Unrelated fixture',visibility:'private'});
 for(const space of [alpha,beta]){roles.setSpaceMember(space.id,'owner','editor');roles.setSpaceMember(space.id,'reader','reader');roles.setSpaceMember(space.id,'other','editor');}roles.setSpaceMember(unavailable.id,'other','editor');
 const marker='BODY_NOT_QUEUE_METADATA';
 const fixtures=[];
 for(const [space,title,state,owner] of [[alpha,'Alpha handbook','unreviewed',null],[alpha,'Stale platform runbook','stale','owner'],[alpha,'Changed procedure','changed','other'],[beta,'Overdue science plan','overdue','owner'],[beta,'Verified results','verified','other'],[beta,'=SUM(1,2)\n"Quoted" export','unreviewed',null],[unavailable,'Other team page','unreviewed',null]]){
  const page=data.createPage({spaceId:space.id,title,content:JSON.stringify([{id:'body',type:'paragraph',content:[{type:'text',text:marker,styles:{}}],children:[]}]),published:fixtures.length%2===0});
  if(state==='stale')db.prepare('UPDATE pages SET updated_at=? WHERE id=?').run(Date.now()-200*86400000,page.id);
  if(owner||['changed','verified','overdue'].includes(state))db.prepare('INSERT INTO document_reviews(page_id,owner_id,due_at,verified_at,verified_by,verified_revision) VALUES(?,?,?,?,?,?)').run(page.id,owner,state==='overdue'?Date.now()-86400000:Date.now()+86400000,['changed','verified'].includes(state)?Date.now()-1000:null,['changed','verified'].includes(state)?'other':null,state==='verified'?checksModule.qualityRevision(data.getPage(page.id)):state==='changed'?'old-revision':null);
  fixtures.push({page,space,state,owner});
 }
 const snapshot=()=>JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}"`).all()]));
 const base=quality.qualityPages(users.owner);check(base.length,6);for(const item of base)check(item.state,fixtures.find(f=>f.page.id===item.id).state);
 const queue=load('lib/quality-queue.ts'),route=load('app/api/quality/queue/route.ts').GET;
 const defaults={search:'',state:'all',owner:'all'};check(queue.normalizeQualityQueueFilters(),defaults);check(queue.normalizeQualityQueueFilters({search:'  alpha  ',state:'',owner:''}),{...defaults,search:'alpha'});
 const before=snapshot();
 for(const state of queue.QUALITY_QUEUE_STATES){const filtered=queue.filterQualityQueue(base,'owner',{...defaults,state});check(filtered.map(p=>p.id),base.filter(p=>p.state===state).sort((a,b)=>a.space_name<b.space_name?-1:a.space_name>b.space_name?1:a.title<b.title?-1:a.title>b.title?1:a.id.localeCompare(b.id)).map(p=>p.id));}
 check(queue.filterQualityQueue(base,'owner',{...defaults,owner:'me'}).map(p=>p.id),fixtures.filter(f=>f.owner==='owner').map(f=>f.page.id));
 check(queue.filterQualityQueue(base,'owner',{...defaults,owner:'unassigned'}).length,2);check(queue.filterQualityQueue(base,'owner',{...defaults,search:'PLATFORM stale'}).map(p=>p.id),[fixtures[1].page.id]);check(queue.filterQualityQueue(base,'owner',{...defaults,search:marker}),[],'search uses title/space not body');check(queue.filterQualityQueue(base,'owner',{...defaults,search:'science',owner:'me',state:'overdue'}).map(p=>p.id),[fixtures[3].page.id]);
 const original=JSON.stringify(base),tied=[{...base[0],id:'b'},{...base[0],id:'a'}];check(queue.filterQualityQueue(tied,'owner',defaults).map(p=>p.id),['a','b']);check(JSON.stringify(base),original);
 for(const input of [{state:'unknown'},{owner:'other'},{search:'a'.repeat(201)}]){assert.throws(()=>queue.normalizeQualityQueueFilters(input),/Invalid/);checks++;}
 const report=queue.createQualityQueueReport(users.owner);check(report.counts,{editable:6,matched:6,exported:6});check(report.rows.map(row=>row.pageId),queue.filterQualityQueue(base,'owner',defaults).map(p=>p.id));
 const rowKeys=['dueAt','href','ownerId','pageId','published','reviewState','revision','spaceName','spaceSlug','title','verifiedAt'];for(const row of report.rows)check(Object.keys(row).sort(),rowKeys);
 for(const text of [marker,'owner@example.test','password_hash','content_text','command','feedback'])check(JSON.stringify(report).includes(text),false,'export excludes nonqueue fields');
 const parseCsv=text=>{const rows=[];let row=[],cell='',quoted=false;for(let i=0;i<text.length;i++){const char=text[i];if(char==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(char===','&&!quoted){row.push(cell);cell='';}else if(char==='\n'&&!quoted){row.push(cell.endsWith('\r')?cell.slice(0,-1):cell);rows.push(row);row=[];cell='';}else cell+=char;}return rows;};
 const csv=queue.qualityQueueCsv(report),csvRows=parseCsv(csv);check(csvRows.length,7);check(csvRows[0],['pageId','title','href','spaceName','spaceSlug','published','reviewState','ownerId','dueAt','verifiedAt','revision']);check(csvRows.find(row=>row[0]===fixtures[5].page.id)[1],"'"+fixtures[5].page.title,'formula prefix neutralized with quotes/newline preserved');
 for(const title of ['=1+2','+1','-1','@sum(A1)',' \t=1','\u200b=1']){const text=queue.qualityQueueCsv({...report,rows:[{...report.rows[0],title}]});check(parseCsv(text)[1][1],"'"+title);}
 check(snapshot(),before,'pure filters/reports/CSV do not mutate SQLite');
 const get=params=>route(new Request('http://localhost/api/quality/queue?'+new URLSearchParams(params)));
 for(const format of ['json','csv']){const response=await get({format,search:'science',state:'overdue',owner:'me'});check(response.status,200);check(response.headers.get('cache-control'),'private, no-store');check(response.headers.get('content-disposition'),`attachment; filename="octavo-quality-queue.${format}"`);check(response.headers.get('x-octavo-matched-rows'),'1');if(format==='json'){const payload=await response.json();check(payload.rows.map(row=>row.pageId),[fixtures[3].page.id]);check(payload.filters,{search:'science',state:'overdue',owner:'me'});}else{const downloaded=parseCsv(await response.text());check(downloaded.length,2);check(downloaded[1][0],fixtures[3].page.id);}}
 for(const params of [{state:'unknown'},{owner:'other'},{search:'a'.repeat(201)},{format:'pdf'}])check((await get(params)).status,400);
 for(const actor of [null,'agent','reader']){cookie=actor?'session-'+actor:undefined;const response=await get({format:'json'});check(response.status,actor==='reader'?200:404);if(actor==='reader')check((await response.json()).rows,[]);else await response.text();}cookie='session-owner';
 check(snapshot(),before,'queue route reads do not mutate fixture data');
 roles.removeSpaceMember(alpha.id,'owner');check((await (await get({search:'Alpha'})).json()).rows,[],'current membership reflected in next export');roles.setSpaceMember(alpha.id,'owner','editor');
 const afterMembership=snapshot();await get({format:'json'});check(snapshot(),afterMembership,'reads remain mutation-free after membership changes');
 // Export bound is exercised against actual rows, not a mocked report generator.
 const stamp=Date.now();const insert=db.prepare('INSERT INTO pages(id,space_id,parent_id,slug,title,content,content_text,position,published,created_at,updated_at) VALUES(?,?,NULL,?,?,?, ?,?,0,?,?)');
 db.transaction(()=>{for(let i=0;i<queue.QUALITY_QUEUE_EXPORT_LIMIT+1;i++)insert.run('bulk'+i,alpha.id,'bulk-'+i,'Bulk '+String(i).padStart(5,'0'),'[]','',i,stamp,stamp);})();
 const bounded=queue.createQualityQueueReport(users.owner,{search:'Bulk'});check(bounded.counts,{editable:5007,matched:5001,exported:5000});check(bounded.truncated,true);check(bounded.rows.length,queue.QUALITY_QUEUE_EXPORT_LIMIT);check(bounded.rows[0].title,'Bulk 00000');check(bounded.rows.at(-1).title,'Bulk 04999');
 const boundedResponse=await get({search:'Bulk',format:'json'});check(boundedResponse.headers.get('x-octavo-export-truncated'),'true');check((await boundedResponse.json()).rows.length,5000);
 console.log(`${checks} quality queue functional checks passed (isolated SQLite)`);
}finally{
 if(db?.open)db.close();delete globalThis.__octavoDb;
 Module._load=oldLoad;if(oldTs)Module._extensions['.ts']=oldTs;else delete Module._extensions['.ts'];if(oldTsx)Module._extensions['.tsx']=oldTsx;else delete Module._extensions['.tsx'];
 globalThis.fetch=oldFetch;console.error=oldError;fs.rmSync(temporary,{recursive:true,force:true});
}
