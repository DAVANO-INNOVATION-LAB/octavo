// Real Chromium + production Next build; isolated synthetic data, no external service.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import Module,{createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),temp=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-editor-browser-'));
process.env.OCTAVO_DATA_DIR=path.join(temp,'data');
const originalLoad=Module._load,originalTs=Module._extensions['.ts'];
Module._load=function(n,p,m){if(n==='server-only')return {};if(n==='next/headers')return {cookies:async()=>({get:()=>undefined})};return originalLoad.call(this,n,p,m);};
Module._extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=async()=>{const s=net.createServer().listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;};
let db,server,chrome,ws;const logs=[];
try {
 db=require('../src/lib/db.ts').getDb();const data=require('../src/lib/data.ts');
 db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run('browser-admin','browser@example.test','Browser Admin','!','admin',Date.now());
 db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run('synthetic-browser','browser-admin',Date.now()+86400000);
 const space=data.createSpace({name:'Browser revision test',visibility:'private'}),page=data.createPage({spaceId:space.id,title:'Original',published:true,content:JSON.stringify([{id:'p',type:'paragraph',content:[{type:'text',text:'Preserve this body',styles:{}}],children:[]}])});
 const httpPort=await port(),cdpPort=await port(),base=`http://${process.env.OCTAVO_TEST_LAUNCH==='dev'?'localhost':'127.0.0.1'}:${httpPort}`;
 const launch=process.env.OCTAVO_TEST_LAUNCH;
 if(launch && !['dev','start'].includes(launch))throw Error('Unsupported test launch');
 if(!launch){fs.cpSync('server','.next/standalone/server',{recursive:true});for(const [from,to] of [['public','.next/standalone/public'],['.next/static','.next/standalone/.next/static']])if(!fs.existsSync(to))fs.symlinkSync(path.resolve(from),to,'dir');}
 server=spawn(launch?'npm':process.execPath,launch?['run',launch]:[path.resolve('.next/standalone/server/octavo-server.cjs')],{detached:true,env:{...process.env,OCTAVO_COLLAB:launch?undefined:process.env.OCTAVO_TEST_DISABLE_PERSISTENCE==='1'?undefined:'0',OCTAVO_COLLAB_PERSISTENCE:process.env.OCTAVO_TEST_DISABLE_PERSISTENCE==='1'?'0':undefined,PORT:String(httpPort),HOSTNAME:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
 for(const stream of [server.stdout,server.stderr])stream.on('data',b=>logs.push(b.toString()));
 for(let i=0;;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}if(i>100)throw Error('Next startup failed');await sleep(100);}
 chrome=spawn(process.env.CHROME_BIN||'/usr/bin/chromium',['--headless=new','--no-sandbox','--disable-gpu','--no-first-run',`--remote-debugging-port=${cdpPort}`,`--user-data-dir=${temp}/chrome`,'about:blank'],{stdio:['ignore','pipe','pipe']});
 chrome.stderr.on('data',b=>logs.push(b.toString()));
 let endpoint;for(let i=0;;i++){try{endpoint=(await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()).webSocketDebuggerUrl;if(endpoint)break;}catch{}if(i>100)throw Error('Chromium startup failed');await sleep(100);}
 ws=new WebSocket(endpoint);await once(ws,'open');let seq=0;const pending=new Map(),exceptions=[],sockets=[];
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p?.reject(Error(JSON.stringify(m.error)));else p?.resolve(m.result);}else if(m.method==='Network.webSocketCreated')sockets.push(m.params.url);else if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails);};
 const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,sessionId}));});
 const evaluate=async(s,expression)=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},s);if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 const until=async(s,expression)=>{for(let i=0;i<150;i++){if(await evaluate(s,expression))return;await sleep(100);}throw Error('Browser condition timed out: '+expression+' exceptions='+JSON.stringify(exceptions)+' body='+await evaluate(s,'document.body.innerText'));};
 const tab=async(targetPage=page)=>{const {targetId}=await send('Target.createTarget',{url:'about:blank'});const {sessionId:s}=await send('Target.attachToTarget',{targetId,flatten:true});await send('Runtime.enable',{},s);await send('Page.enable',{},s);await send('Network.enable',{},s);await send('Network.setCookie',{name:'octavo_session',value:'synthetic-browser',url:base},s);await send('Page.navigate',{url:`${base}/${space.slug}/${targetPage.slug}/edit`},s);await until(s,'!!document.querySelector("textarea") && !!document.querySelector(".bn-editor")');await sleep(500);return s;};
 const edit=async(s,text)=>{await evaluate(s,`(()=>{const el=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);};
 if(launch){const authorization=await fetch(`${base}/api/collab/authorize?page=${page.id}&claim=1`,{headers:{cookie:'octavo_session=synthetic-browser'}});assert.equal(authorization.status,503);assert.equal(db.prepare('SELECT count(*) n FROM collab_docs WHERE page_id=?').get(page.id).n,0);console.log('ok npm '+launch+' refuses collaboration without seeding');}
 const a=await tab(),b=await tab();
 await edit(a,'First browser save');await until(a,"document.body.innerText.toLowerCase().includes('saved')");assert.equal(data.getPage(page.id).title,'First browser save');console.log('ok real browser first save persists');
 await edit(b,'Stale browser draft');await until(b,"document.body.innerText.toLowerCase().includes('page changed')");assert.equal(data.getPage(page.id).title,'First browser save');assert.equal(await evaluate(b,"document.querySelector('textarea').value"),'Stale browser draft');console.log('ok real stale tab pauses and keeps its draft without overwriting');
 await edit(b,'Latest retained draft');await sleep(1000);assert.equal(data.getPage(page.id).title,'First browser save');assert.ok(await evaluate(b,"Object.values(localStorage).some(v=>v.includes('Latest retained draft'))"));console.log('ok further edits retained locally without implicit retry');
 await send('Page.reload',{},b);await until(b,"document.body.innerText.includes('Unsaved drafts from another session')");assert.equal(await evaluate(b,"document.querySelector('textarea').value"),'First browser save');assert.ok(await evaluate(b,"Object.values(localStorage).some(v=>v.includes('Latest retained draft'))"));console.log('ok reload exposes recovery without replaying stale content');
 const downloads=path.join(temp,'downloads');fs.mkdirSync(downloads);await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});await evaluate(b,"[...document.querySelectorAll('button')].find(x=>x.innerText.startsWith('Download draft')).click()");for(let i=0;i<50&&!fs.readdirSync(downloads).some(n=>n.endsWith('.json'));i++)await sleep(100);const files=fs.readdirSync(downloads).filter(n=>n.endsWith('.json'));assert.equal(files.length,1);assert.equal(JSON.parse(fs.readFileSync(path.join(downloads,files[0]),'utf8')).title,'Latest retained draft');console.log('ok real browser downloads recoverable draft');
 const draftPage=data.createPage({spaceId:space.id,title:'Draft original',content:page.content});const d=await tab(draftPage),e=await tab(draftPage);await edit(d,'Draft renamed');await until(d,"document.body.innerText.toLowerCase().includes('saved')");await edit(e,'Retained after rename');await until(e,"document.body.innerText.toLowerCase().includes('page changed')");await send('Page.reload',{},e);await until(e,"document.body.innerText.includes('404')");const canonical=data.getPage(draftPage.id).slug;await send('Page.navigate',{url:`${base}/${space.slug}/${canonical}/edit`},e);await until(e,"document.body.innerText.includes('Unsaved drafts from another session')");assert.equal(await evaluate(e,"document.querySelector('textarea').value"),'Draft renamed');assert.ok(await evaluate(e,"Object.values(localStorage).some(v=>v.includes('Retained after rename'))"));console.log('ok unpublished old slug404 retains draft; canonical URL exposes recovery');
 assert.equal(sockets.filter(url=>new URL(url).pathname==='/collab').length,0,JSON.stringify(sockets));console.log("ok disabled collaboration opens no collaboration websocket");
 assert.equal(exceptions.length,0,JSON.stringify(exceptions));console.log('6 real Chromium editor cases passed; no runtime exceptions');
} catch(e){console.error(logs.join(''));throw e;} finally {ws?.close();chrome?.kill('SIGTERM');if(server?.pid){try{process.kill(-server.pid,'SIGTERM');}catch{server.kill('SIGTERM');}}await sleep(500);db?.close();delete globalThis.__octavoDb;Module._load=originalLoad;Module._extensions['.ts']=originalTs;fs.rmSync(temp,{recursive:true,force:true});}
