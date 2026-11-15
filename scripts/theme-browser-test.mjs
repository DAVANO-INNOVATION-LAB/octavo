// Real Chrome theme acceptance, isolated synthetic accounts and loopback server.
import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';import {once} from 'node:events';import {spawn,spawnSync} from 'node:child_process';import Module,{createRequire} from 'node:module';import ts from 'typescript';import Database from 'better-sqlite3';
const require=createRequire(import.meta.url),sleep=ms=>new Promise(r=>setTimeout(r,ms));
if(process.argv[2]==='--seed'){
 const old=Module._load;Module._load=function(n,p,m){if(n==='server-only')return {};if(n==='next/headers')return {cookies:async()=>({get:()=>undefined})};return old.call(this,n,p,m)};
 Module._extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
 const db=require('../src/lib/db.ts').getDb(),data=require('../src/lib/data.ts');
 for(const [id,role] of [['admin','admin'],['reader','reader']]){db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id,`${id}@example.test`,id,'!',role,Date.now());db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run('exchange-'+id,id,Date.now()+86400000);}
 const space=data.createSpace({name:'Synthetic Exchange',visibility:'private'});let page=null;if(process.argv[3]==='a')page=data.createPage({spaceId:space.id,title:'Shared Guide',published:false,content:JSON.stringify([{id:'base-block',type:'paragraph',content:[{type:'text',text:'Initial saved body',styles:{}}],children:[]}])});
 if(page){const {UPLOADS_DIR}=require('../src/lib/db.ts');fs.mkdirSync(UPLOADS_DIR,{recursive:true});fs.writeFileSync(path.join(UPLOADS_DIR,'abcdef123456.txt'),'synthetic verified attachment');db.prepare('INSERT INTO uploads(name,uploaded_by,space_id,created_at) VALUES(?,?,?,?)').run('abcdef123456.txt','admin',space.id,Date.now());const blocks=JSON.parse(page.content);blocks.push({id:'file-block',type:'file',props:{url:'/api/files/abcdef123456.txt',name:'abcdef123456.txt'},children:[]});data.savePage(page.id,{content:JSON.stringify(blocks)});}
 console.log(JSON.stringify({space,page}));db.close();process.exit(0);
}
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-exchange-browser-')),logs=[],servers=[],dbs=[];let chrome,ws;let checks=0;
const port=async()=>{const s=net.createServer().listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;};
try{
 fs.cpSync('server','.next/standalone/server',{recursive:true});for(const [from,to] of [['public','.next/standalone/public'],['.next/static','.next/standalone/.next/static']])if(!fs.existsSync(to))fs.cpSync(from,to,{recursive:true});
 const sites=[];
 for(const name of ['a']){
  const dir=path.join(temp,name);fs.mkdirSync(dir,{recursive:true});const env={...process.env,OCTAVO_DATA_DIR:dir,OCTAVO_EXCHANGE_DELTA:'1',OCTAVO_EXCHANGE_STAGING:'1'};
  const seeded=spawnSync(process.execPath,[path.resolve('scripts/theme-browser-test.mjs'),'--seed',name],{env,encoding:'utf8'});if(seeded.status!==0)throw Error(seeded.stderr);const fixture=JSON.parse(seeded.stdout.trim());
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
 for(const site of sites){const {browserContextId}=await send('Target.createBrowserContext');site.context=browserContextId;site.downloads=path.join(temp,site.name+'-downloads');fs.mkdirSync(site.downloads);await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:site.downloads,browserContextId});const {targetId}=await send('Target.createTarget',{url:'about:blank',browserContextId});const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});site.session=sessionId;await send('Runtime.enable',{},sessionId);await send('Page.enable',{},sessionId);await send('Network.setCookie',{name:'octavo_session',value:'exchange-admin',url:site.base},sessionId);await navigate(site,'/admin/exchange');await until(sessionId,"document.body.innerText.includes('Bind a private space') && !!document.querySelector('select')");}

 const A=sites[0],S=A.session;
 await until(S,"!!document.querySelector('dialog[open] #release-title')");
 await evaluate(S,"[...document.querySelectorAll('dialog button')].find(b=>b.innerText==='Got it').click()");await until(S,"!document.querySelector('dialog[open]')");
 // Pin the month so the original seasonal override is reproducible all year.
 await send('Page.addScriptToEvaluateOnNewDocument',{source:`{const D=Date;window.Date=class extends D{getMonth(){return 10}}}`},S);
 await evaluate(S,"localStorage.removeItem('octavo-seasonal');localStorage.removeItem('octavo-palette')");
 await navigate(A,'/');await until(S,"!!document.querySelector('[aria-label=\"Theme presets\"]')");
 assert.equal(await evaluate(S,"document.documentElement.dataset.palette"),'harvest');checks++;
 const presets=[['Paper & Ink',null],['Slate','slate'],['Forest','forest'],['Indigo','indigo'],['Rosewood','rosewood'],['Graphite','graphite']];
 for(const mode of ['light','dark']){
  await evaluate(S,`localStorage.setItem('octavo-theme','${mode}');document.documentElement.dataset.theme='${mode}'`);
  let lastAccent=null;
  for(const [label,id] of presets){
   await evaluate(S,"document.querySelector('[aria-label=\"Theme presets\"]').click()");
   await until(S,"[...document.querySelectorAll('button')].some(b=>b.innerText.includes('Paper & Ink'))");
   await evaluate(S,`[...document.querySelectorAll('button')].find(b=>b.innerText.startsWith(${JSON.stringify(label)})).click()`);
   assert.equal(await evaluate(S,"document.documentElement.getAttribute('data-palette')"),id);
   assert.equal(await evaluate(S,"localStorage.getItem('octavo-seasonal')"),'off');
   const accent=await evaluate(S,"getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()");assert.ok(accent);assert.notEqual(accent,lastAccent);lastAccent=accent;
   assert.equal(await evaluate(S,`[...document.querySelectorAll('button')].find(b=>b.innerText.startsWith(${JSON.stringify(label)})).getAttribute('aria-pressed')`),'true');
   await navigate(A,'/');await until(S,"!!document.querySelector('[aria-label=\"Theme presets\"]')");
   assert.equal(await evaluate(S,"document.documentElement.getAttribute('data-palette')"),id);assert.equal(await evaluate(S,"document.documentElement.dataset.theme"),mode);checks++;
  }
 }
 await evaluate(S,"document.querySelector('[aria-label=\"Theme presets\"]').click()");await until(S,"[...document.querySelectorAll('button')].some(b=>b.innerText.includes('Harvest'))");
 await evaluate(S,"[...document.querySelectorAll('button')].find(b=>b.innerText.startsWith('Harvest')).click()");
 assert.equal(await evaluate(S,"document.documentElement.dataset.palette"),'harvest');
 assert.equal(await evaluate(S,"[...document.querySelectorAll('button')].find(b=>b.innerText.startsWith('Graphite')).getAttribute('aria-pressed')"),'false');checks++;
 await navigate(A,'/');await until(S,"!!document.querySelector('[aria-label=\"Theme presets\"]')");assert.equal(await evaluate(S,"document.documentElement.dataset.palette"),'harvest');checks++;
 await evaluate(S,"document.querySelector('[aria-label=\"Toggle light or dark\"]').click()");
 assert.equal(await evaluate(S,"document.documentElement.dataset.theme"),'light');checks++;
 await navigate(A,'/');await until(S,"!!document.querySelector('[aria-label=\"Theme presets\"]')");assert.equal(await evaluate(S,"document.documentElement.dataset.theme"),'light');checks++;
 assert.equal(exceptions.length,0,JSON.stringify(exceptions));console.log(`${checks} theme browser groups passed, zero runtime exceptions`);
}catch(error){console.error(logs.join(''));throw error;}finally{ws?.close();chrome?.kill('SIGTERM');for(const s of servers)if(s.pid){try{process.kill(-s.pid,'SIGTERM')}catch{s.kill('SIGTERM')}}await sleep(500);for(const db of dbs)db.close();console.log('Evidence directory',temp);}
