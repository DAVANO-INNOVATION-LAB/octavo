// Compiled Next HTTP smoke. Run npm run build first. Uses an isolated database and loopback server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import Module, { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-review-next-http-'));
process.env.OCTAVO_DATA_DIR = path.join(temporary, 'data');
const originalLoad = Module._load, originalTs = Module._extensions['.ts'];
let db, server, logPath, lastRequest;
Module._load = function(name, parent, main) {
  if (name === 'server-only') return {};
  if (name === 'next/headers') return { cookies: async () => ({ get: () => undefined }) };
  return originalLoad.call(this, name, parent, main);
};
Module._extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, file);
try {
  assert.ok(fs.existsSync('.next/BUILD_ID'), 'Run npm run build first');
  db = require('../src/lib/db.ts').getDb();
  const data = require('../src/lib/data.ts');
  const roles=require('../src/lib/roles.ts');
  for (const name of ['owner', 'reader', 'outsider', 'agent', 'excluded', 'admin']) {
    db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(name, `${name}@example.test`, name, '!', name === 'agent' ? 'agent' : name === 'admin' ? 'admin' : 'member', Date.now());
    db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run(`synthetic-${name}`, name, Date.now() + 86400000);
  }
  const space=data.createSpace({name:'Quality team',visibility:'private'});roles.setSpaceMember(space.id,'owner','editor');roles.setSpaceMember(space.id,'reader','reader');
  const fixture=[];for(let i=0;i<35;i++){const page=data.createPage({spaceId:space.id,title:'Target '+String(i).padStart(2,'0'),content:JSON.stringify([{type:'paragraph',content:[{type:'text',text:'BODY_EXCLUDED_FROM_EXPORT',styles:{}}],children:[]}])});db.prepare('INSERT INTO document_reviews(page_id,owner_id,due_at) VALUES(?,?,?)').run(page.id,'owner',Date.now()+86400000);fixture.push(page);}
  data.createPage({spaceId:space.id,title:'Different document'});
  const socket = net.createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening'); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  logPath = path.join(temporary, 'server.log');
  const log = fs.openSync(logPath, 'a');
  server = spawn(process.execPath, [path.resolve('.next/standalone/server.js')], {
    cwd: process.cwd(), env: { ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1', OCTAVO_COLLAB: '0' }, stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${base}/api/health`,{signal:AbortSignal.timeout(1000)})).ok) break; } catch {}
    if (attempt >= 100 || server.exitCode !== null) throw new Error(`Test server failed: ${fs.readFileSync(logPath, 'utf8')}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const health=await fetch(`${base}/api/health`,{signal:AbortSignal.timeout(5000)});assert.equal((await health.json()).version,JSON.parse(fs.readFileSync('package.json','utf8')).version,'Compiled build matches checkout');
  const request = (url, who, options = {}) => {
    lastRequest = `${options.method ?? 'GET'} ${url} actor=${who ?? 'anonymous'}`;
    return fetch(`${base}${url}`, { redirect: 'manual', signal:AbortSignal.timeout(15000), ...options,
      headers: { connection: 'close', ...(who ? { cookie: `octavo_session=synthetic-${who}` } : {}), ...options.headers } });
  };
  let checks = 0;
  const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
  const htmlAt=async url=>{const response=await request(url,'owner');check(response.status,200,lastRequest);return(await response.text()).replace(/<!--[\s\S]*?-->/g,'');};
  const decode=value=>value.replaceAll('&amp;','&').replaceAll('&quot;','"').replaceAll('&#x27;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>');
  const renderedForm=async(page,params={},operation='verify')=>{
    const html=await htmlAt('/quality?'+new URLSearchParams({search:'Target',state:'all',owner:'me',page:page.id,...params}));
    const form=(html.match(/<form\b[\s\S]*?<\/form>/g)??[]).find(form=>form.includes(`name="operation" value="${operation}"`));assert.ok(form,'actual compiled operation form');checks++;
    const body=new FormData();for(const tag of form.match(/<input\b[^>]*>/g)??[]){const name=tag.match(/name="([^"]+)"/)?.[1],value=tag.match(/value="([^"]*)"/)?.[1];if(name)body.set(decode(name),decode(value??''));}
    assert.ok([...body.keys()].some(key=>key.startsWith('$ACTION_ID_')));checks++;
    for(const [key,value]of Object.entries({queueSearch:params.search??'Target',queueState:params.state??'all',queueOwner:params.owner??'me',queuePage:params.queue??'1'}))check(body.get(key),value,'rendered context '+key);
    if(operation==='verify')assert.ok((form.match(/<button\b[^>]*>/g)??[]).some(tag=>tag.includes('name="advance"')&&tag.includes('value="1"')),'explicit advance submit button');
    return {body,html};
  };
  const post=async body=>{const response=await request('/quality','owner',{method:'POST',headers:{origin:base},body});await response.text();check(response.status,303,lastRequest);const location=response.headers.get('location');assert.ok(location);return new URL(location,base);};
  const pagesSnapshot=()=>JSON.stringify(db.prepare('SELECT * FROM pages ORDER BY id').all());
  const snapshot=()=>JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}"`).all()]));
  const reviewed=()=>db.prepare('SELECT COUNT(*) AS n FROM document_reviews WHERE verified_at IS NOT NULL').get().n;
  const beforePages=pagesSnapshot();
  let current=await renderedForm(fixture[29]);current.body.set('advance','1');let result=await post(current.body);
  check(result.searchParams.get('page'),fixture[30].id);check(result.searchParams.get('queue'),'2');check(result.searchParams.get('advanced'),'1');check(result.searchParams.get('reviewed'),'1');check(reviewed(),1);check(pagesSnapshot(),beforePages);
  let html=await htmlAt(result.pathname+result.search);assert.match(html,/>Target 30<\/h2>/);checks++;
  current=await renderedForm(fixture[30],{queue:'2'});result=await post(current.body);check(result.searchParams.get('page'),fixture[30].id);check(result.searchParams.get('queue'),'2');check(result.searchParams.has('advanced'),false);check(reviewed(),2);
  current=await renderedForm(fixture[34],{queue:'2'});current.body.set('advance','1');result=await post(current.body);check(result.searchParams.get('page'),fixture[0].id);check(result.searchParams.get('queue'),'1');check(reviewed(),3);
  // Stale revision leaves review, content, audit, and related rows exactly as before submission.
  current=await renderedForm(fixture[4]);current.body.set('advance','1');data.savePage(fixture[4].id,{title:'Target 04 updated'});const stale=snapshot();result=await post(current.body);assert.match(result.searchParams.get('error'),/Page changed/);checks++;check(result.searchParams.get('page'),fixture[4].id);check(result.searchParams.has('advanced'),false);check(snapshot(),stale);
  current=await renderedForm(fixture[10],{search:'Target 10',state:'unreviewed'});current.body.set('advance','1');result=await post(current.body);check(result.searchParams.get('completed'),'1');check(result.searchParams.get('page'),fixture[10].id);html=await htmlAt(result.pathname+result.search);check(html.includes('data-testid="quality-selected-page"'),false);assert.match(html,/No (?:other |matching )?documents|queue.*(?:complete|empty)|completed/i);checks++;
  const completionUrl=result.pathname+result.search;
  const added=data.createPage({spaceId:space.id,title:'Target 10 newly queued'});db.prepare('INSERT INTO document_reviews(page_id,owner_id) VALUES(?,?)').run(added.id,'owner');
  html=await htmlAt(completionUrl);assert.match(html,/queue has changed; choose a document below/i);assert.match(html,/>Target 10 newly queued<\/h2>/);check(html.includes('Review recorded. No other documents match'),false);checks++;
  current=await renderedForm(fixture[11],{search:'Target 11'});current.body.set('advance','1');result=await post(current.body);check(result.searchParams.get('completed'),'1');check(result.searchParams.get('page'),fixture[11].id);html=await htmlAt(result.pathname+result.search);check(html.includes('data-testid="quality-selected-page"'),false);assert.match(html,/Target 11/);assert.match(html,/No other documents/i);checks++;
  current=await renderedForm(fixture[12]);current.body.set('queueState','invalid');current.body.set('advance','1');const invalid=snapshot();result=await post(current.body);check(result.searchParams.has('error'),true);check(snapshot(),invalid);
  current=await renderedForm(fixture[13]);current.body.delete('queueOwner');current.body.set('advance','1');const missing=snapshot();result=await post(current.body);check(result.searchParams.has('error'),true);check(snapshot(),missing);
  // Ordinary assignment keeps context without invoking continuation.
  current=await renderedForm(fixture[31],{queue:'2'},'assign');current.body.set('ownerId','owner');result=await post(current.body);for(const [key,value]of Object.entries({search:'Target',state:'all',owner:'me',queue:'2',page:fixture[31].id,saved:'1'}))check(result.searchParams.get(key),value);
  current=await renderedForm(fixture[14]);current.body.set('advance','1');roles.removeSpaceMember(space.id,'owner');const removed=snapshot();result=await post(current.body);check(result.searchParams.has('error'),true);check(snapshot(),removed);check(result.searchParams.has('advanced'),false);
  console.log(`${checks} review-next compiled HTTP checks passed (actual rendered forms/action/session and isolated SQLite)`);
} catch (error) {
  await new Promise(resolve => setTimeout(resolve, 100));
  console.error(`HTTP fixture failed at ${lastRequest}; server exit=${server?.exitCode} signal=${server?.signalCode}`);
  if (logPath && fs.existsSync(logPath)) console.error(fs.readFileSync(logPath, 'utf8').slice(-6000));
  throw error;
} finally {
  if (server && server.exitCode === null && server.signalCode === null) { const done=once(server,'exit');server.kill('SIGTERM');const timer=setTimeout(()=>server.kill('SIGKILL'),3000);try{await done;}finally{clearTimeout(timer);} }
  db?.close();
  Module._load = originalLoad;
  if (originalTs) Module._extensions['.ts'] = originalTs; else delete Module._extensions['.ts'];
  fs.rmSync(temporary, { recursive: true, force: true });
}
