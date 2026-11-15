// Real pagination/full-revision Chrome acceptance, isolated synthetic accounts and loopback server.
import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';import {once} from 'node:events';import {spawn,spawnSync} from 'node:child_process';import Module,{createRequire} from 'node:module';import ts from 'typescript';import Database from 'better-sqlite3';
const require=createRequire(import.meta.url),sleep=ms=>new Promise(r=>setTimeout(r,ms));
if(process.argv[2]==='--seed'){
 const old=Module._load;Module._load=function(n,p,m){if(n==='server-only')return {};if(n==='next/headers')return {cookies:async()=>({get:()=>undefined})};return old.call(this,n,p,m)};
 Module._extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
 const db=require('../src/lib/db.ts').getDb(),data=require('../src/lib/data.ts');
 for(const [id,role] of [['admin','admin'],['reader','reader']]){db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id,`${id}@example.test`,id,'!',role,Date.now());db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run('exchange-'+id,id,Date.now()+86400000);}
 const space=data.createSpace({name:'Pagination browser fixture',visibility:'private'});
 const app=require('../src/lib/site-exchange-app.ts'),{SiteExchange}=require('../src/lib/site-exchange.ts');
 const body=text=>JSON.stringify([{id:'long',type:'paragraph',content:[{type:'text',text,styles:{}}],children:[]}]);
 const page=data.createPage({spaceId:space.id,title:'Long browser document',content:body('BASE-'+ 'b'.repeat(12000))});
 for(let i=0;i<104;i++)data.createPage({spaceId:space.id,title:'Additional page '+i,content:body('short '+i)});
 const {lineage}=app.bindExchange(space.id);app.captureExchange(space.id);
 const engine=app.exchangeEngine().engine,docId=db.prepare('SELECT doc_id FROM site_exchange_pages WHERE page_id=?').get(page.id).doc_id;
 const historicalId=engine.heads(lineage,docId)[0].id;
 for(let i=0;i<25;i++){data.savePage(page.id,{content:body('LOCAL-'+i+' '+ 'l'.repeat(13000))});app.captureExchange(space.id);}
 const preConflictBase=engine.heads(lineage,docId)[0].id;
 const peer=new SiteExchange(new Database(':memory:'),SiteExchange.createIdentity());peer.bindScope('remote',lineage);peer.trust(lineage,app.exchangeEngine().identity.publicKey);app.trustExchange(space.id,peer.identity.publicKey);peer.importBundle(engine.exportBundle(lineage));
 data.savePage(page.id,{content:body('LOCAL_CONFLICT '+ 'x'.repeat(14000))});app.captureExchange(space.id);
 const remoteId=peer.capture(lineage,docId,{title:'Long browser document',content:body('REMOTE_CHOICE '+ 'r'.repeat(15000)),deleted:false,parentDocId:null,attachments:[]},[preConflictBase]);
 if(process.env.LARGE_HEADS==='1')for(let i=0;i<99;i++)peer.capture(lineage,docId,{title:'Long browser document',content:body('SIBLING_CONFLICT '+i),deleted:false,parentDocId:null,attachments:[]},[preConflictBase]);
 engine.importBundle(peer.exportBundle(lineage));
 const stress={docId,historicalId,remoteId,initialHeads:engine.heads(lineage,docId).length,initialHistory:engine.revisions(lineage,docId).length,largeHeads:process.env.LARGE_HEADS==='1'};
 assert.equal(stress.initialHeads,stress.largeHeads?101:2);assert.equal(stress.initialHistory,stress.largeHeads?127:28);
 console.log(JSON.stringify({space,page,stress}));db.close();process.exit(0);
}
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-exchange-browser-')),logs=[],servers=[],dbs=[];let chrome,ws;let checks=0;
const port=async()=>{const s=net.createServer().listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;};
try{
 fs.cpSync('server','.next/standalone/server',{recursive:true});for(const [from,to] of [['public','.next/standalone/public'],['.next/static','.next/standalone/.next/static']])if(!fs.existsSync(to))fs.symlinkSync(path.resolve(from),to,'dir');
 const sites=[];
 for(const name of ['a']){
  const dir=path.join(temp,name);fs.mkdirSync(dir,{recursive:true});const env={...process.env,OCTAVO_DATA_DIR:dir};
  const seeded=spawnSync(process.execPath,[path.resolve('scripts/site-exchange-pagination-browser-test.mjs'),'--seed',name],{env,encoding:'utf8'});if(seeded.status!==0)throw Error(seeded.stderr);const fixture=JSON.parse(seeded.stdout.trim());
  const httpPort=await port(),base=`http://127.0.0.1:${httpPort}`;
  const server=spawn(process.execPath,[path.resolve('.next/standalone/server/octavo-server.cjs')],{detached:true,env:{...env,OCTAVO_COLLAB:undefined,OCTAVO_COLLAB_PERSISTENCE:undefined,HOSTNAME:'127.0.0.1',PORT:String(httpPort)},stdio:['ignore','pipe','pipe']});servers.push(server);for(const stream of [server.stdout,server.stderr])stream.on('data',b=>logs.push(`[${name}] ${b}`));
  for(let i=0;;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}if(i>150)throw Error('server startup');await sleep(100);}
  const db=new Database(path.join(dir,'octavo.db'));dbs.push(db);sites.push({name,dir,base,...fixture,db,server,env,httpPort});
 }
 const cdpPort=await port();chrome=spawn(process.env.CHROME_BIN||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${cdpPort}`,`--user-data-dir=${temp}/chrome`,'about:blank'],{stdio:['ignore','pipe','pipe']});chrome.stderr.on('data',b=>logs.push(b.toString()));
 let endpoint;for(let i=0;;i++){try{endpoint=(await(await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()).webSocketDebuggerUrl;if(endpoint)break;}catch{}if(i>150)throw Error('Chrome startup');await sleep(100);}
 ws=new WebSocket(endpoint);await once(ws,'open');let seq=0;const pending=new Map(),exceptions=[];
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p?.reject(Error(JSON.stringify(m.error)));else p?.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails);};
 const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,sessionId}));});
 const evaluate=async(s,expression)=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},s);if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 const until=async(s,expression)=>{for(let i=0;i<200;i++){if(await evaluate(s,expression))return;await sleep(100);}throw Error(`Browser timeout: ${expression}\n${await evaluate(s,'document.body.innerText')}`);};
 const navigate=async(site,url)=>{await send('Page.navigate',{url:site.base+url},site.session);await until(site.session,'document.readyState === "complete"');};
 for(const site of sites){const {browserContextId}=await send('Target.createBrowserContext');site.context=browserContextId;site.downloads=path.join(temp,site.name+'-downloads');fs.mkdirSync(site.downloads);await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:site.downloads,browserContextId});const {targetId}=await send('Target.createTarget',{url:'about:blank',browserContextId});const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});site.session=sessionId;await send('Runtime.enable',{},sessionId);await send('Page.enable',{},sessionId);await send('Network.setCookie',{name:'octavo_session',value:'exchange-admin',url:site.base},sessionId);await navigate(site,'/admin/exchange');await until(sessionId,"document.body.innerText.includes('Documents and conflicts') && !!document.querySelector('select')");}

 const A=sites[0];
 await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false},A.session);
 const capture=async(name,selector)=>{await evaluate(A.session,`(()=>{(${selector}).scrollIntoView({block:'start',behavior:'instant'});window.scrollBy({top:-80,behavior:'instant'});})()`);await evaluate(A.session,"new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");const shot=await send('Page.captureScreenshot',{format:'png'},A.session);fs.writeFileSync(path.join(temp,name+'.png'),Buffer.from(shot.data,'base64'));};
 const docsHeading="[...document.querySelectorAll('h3')].find(h=>h.textContent==='Documents and conflicts')";
 const click=async(text)=>evaluate(A.session,`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent===${JSON.stringify(text)});if(!b)throw Error('Button missing '+${JSON.stringify(text)});b.click();})()`);
 await until(A.session,"document.body.innerText.includes('Showing 100 of 105 documents')");await capture('pagination-count',docsHeading);await capture('pagination-load-more',"[...document.querySelectorAll('button')].find(b=>b.textContent==='Load more documents')");await click('Load more documents');await until(A.session,"document.body.innerText.includes('Showing 105 of 105 documents')");assert.equal(await evaluate(A.session,"[...document.querySelectorAll('summary')].filter(s=>s.parentElement.className.includes('border-line')).length"),105);await capture('pagination-complete',docsHeading);console.log('ok actual UI loads all105 documents');checks++;
 const longDetail="[...document.querySelectorAll('details')].find(d=>d.querySelector('summary')?.textContent.startsWith('Long browser document'))";
 await evaluate(A.session,`(()=>{const d=${longDetail};d.open=true;for(const x of d.querySelectorAll('details'))x.open=true;})()`);
 const loadAllHistory=async(expected)=>{for(let i=0;i<100;i++){
  const before=await evaluate(A.session,`Number((${longDetail}).querySelector(':scope > details > summary').textContent.match(/loaded (\\d+)/)[1])`);
  if(before===expected)break;
  await until(A.session,`[...(${longDetail}).querySelectorAll('button')].some(b=>b.textContent==='Load more retained revisions'&&!b.disabled)`);
  await evaluate(A.session,`[...(${longDetail}).querySelectorAll('button')].find(b=>b.textContent==='Load more retained revisions').click()`);
  await until(A.session,`Number((${longDetail}).querySelector(':scope > details > summary').textContent.match(/loaded (\\d+)/)[1])>${before}`);
 }assert.equal(await evaluate(A.session,`Number((${longDetail}).querySelector(':scope > details > summary').textContent.match(/loaded (\\d+)/)[1])`),expected);};
 assert.equal(await evaluate(A.session,`[...(${longDetail}).querySelectorAll('button')].filter(b=>b.textContent==='Resolve by retaining this revision').length`),A.stress.initialHeads);
 await loadAllHistory(A.stress.initialHistory);console.log(`ok actual UI displays all${A.stress.initialHeads} heads and loads all${A.stress.initialHistory} retained revisions`);checks++;
 const target=`[...(${longDetail}).querySelectorAll('p')].find(p=>p.textContent.startsWith('Revision '+${JSON.stringify(A.stress.remoteId)}))?.parentElement`;
 assert.equal(await evaluate(A.session,`[...(${target}).querySelectorAll('button')].find(b=>b.textContent==='Resolve by retaining this revision').disabled`),true);
 await evaluate(A.session,`[...(${target}).querySelectorAll('button')].find(b=>b.textContent==='Load complete revision').click()`);
 await until(A.session,`(${target}).querySelector('pre').textContent.length>15000 && ![...(${target}).querySelectorAll('button')].find(b=>b.textContent==='Resolve by retaining this revision').disabled`);
 await capture('complete-conflict-review',target);
 await evaluate(A.session,`[...(${target}).querySelectorAll('button')].find(b=>b.textContent==='Resolve by retaining this revision').click()`);await until(A.session,"document.querySelector('[role=status]').textContent.includes('resolved') && !document.body.innerText.includes('Working…')");assert.ok(A.db.prepare('SELECT content FROM pages WHERE id=?').get(A.page.id).content.includes('REMOTE_CHOICE'));const afterMerge=await evaluate(A.session,`fetch('/api/site-exchange?'+new URLSearchParams({spaceId:${JSON.stringify(A.space.id)},docId:${JSON.stringify(A.stress.docId)}})).then(r=>r.json())`);
 assert.equal(afterMerge.documents[0].heads.length,1);const mergeNodes=A.stress.largeHeads?2:1;assert.equal(afterMerge.documents[0].historyCount,A.stress.initialHistory+mergeNodes);console.log(`ok actual UI complete long revision resolves${A.stress.initialHeads} heads atomically using${mergeNodes} merge nodes`);checks++;
 // Actions refresh bounded list. Load all documents/history again and select old long base.
 if(await evaluate(A.session,"[...document.querySelectorAll('button')].some(b=>b.textContent==='Load more documents')")){await click('Load more documents');await until(A.session,"document.body.innerText.includes('Showing 105 of 105 documents')");}
 await evaluate(A.session,`(()=>{const d=${longDetail};d.open=true;for(const x of d.querySelectorAll('details'))x.open=true;})()`);
 await loadAllHistory(A.stress.initialHistory+(A.stress.largeHeads?2:1));
 const historical=`[...(${longDetail}).querySelectorAll('p')].find(p=>p.textContent.startsWith('Revision '+${JSON.stringify(A.stress.historicalId)}))?.parentElement`;
 assert.equal(await evaluate(A.session,`[...(${historical}).querySelectorAll('button')].find(b=>b.textContent==='Restore this retained revision as a new revision').disabled`),true);
 await evaluate(A.session,`[...(${historical}).querySelectorAll('button')].find(b=>b.textContent==='Load complete revision').click()`);await until(A.session,`(${historical}).querySelector('pre').textContent.length>12000 && ![...(${historical}).querySelectorAll('button')].find(b=>b.textContent==='Restore this retained revision as a new revision').disabled`);
 await capture('complete-retained-review',historical);
 await evaluate(A.session,`[...(${historical}).querySelectorAll('button')].find(b=>b.textContent==='Restore this retained revision as a new revision').click()`);for(let i=0;i<200;i++){if(A.db.prepare('SELECT content FROM pages WHERE id=?').get(A.page.id).content.includes('BASE-'))break;if(i===199)throw Error('Restore did not persist');await sleep(100);}console.log('ok actual UI restores complete long retained content to same page');checks++;
 await until(A.session,"!document.body.innerText.includes('Working…')");
 if(await evaluate(A.session,"[...document.querySelectorAll('button')].some(b=>b.textContent==='Load more documents')")){await click('Load more documents');await until(A.session,"document.body.innerText.includes('Showing 105 of 105 documents')");}
 await evaluate(A.session,`(${longDetail}).open=true`);await capture('restored-long-document',longDetail);
 assert.equal(exceptions.length,0,JSON.stringify(exceptions));console.log(`${checks} pagination/full-review Chrome groups passed; zero runtime exceptions`);
 fs.writeFileSync(path.join(temp,'result.json'),JSON.stringify({checks,exceptions:exceptions.length,passed:true,initialHeads:A.stress.initialHeads,initialHistory:A.stress.initialHistory,largeHeads:A.stress.largeHeads},null,2));
}catch(error){console.error(logs.join(''));throw error;}finally{ws?.close();chrome?.kill('SIGTERM');for(const s of servers)if(s.pid){try{process.kill(-s.pid,'SIGTERM')}catch{s.kill('SIGTERM')}}await sleep(500);for(const db of dbs)db.close();if(process.env.KEEP_EXCHANGE_TEST==='1')console.log('Evidence directory',temp);else fs.rmSync(temp,{recursive:true,force:true});}
