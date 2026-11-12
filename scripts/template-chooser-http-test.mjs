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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-template-chooser-http-'));
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
  const {TEMPLATES}=require('../src/lib/templates.ts'),{buildTemplateCatalog}=require('../src/lib/template-catalog.ts');
  const catalog=buildTemplateCatalog(TEMPLATES);
  for (const name of ['owner', 'reader', 'outsider', 'agent', 'excluded', 'admin']) {
    db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(name, `${name}@example.test`, name, '!', name === 'agent' ? 'agent' : name === 'admin' ? 'admin' : 'member', Date.now());
    db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run(`synthetic-${name}`, name, Date.now() + 86400000);
  }
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
  const snapshot=()=>JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}"`).all()]));
  for(const [who,destination] of [[null,'/login'],['agent','/']]){
    const response=await request('/new',who);await response.text();assert.ok([303,307].includes(response.status),lastRequest);assert.equal(response.headers.get('location'),destination);checks++;
  }
  const response=await request('/new','owner');assert.equal(response.status,200);const html=await response.text();
  const forms=html.match(/<form\b[\s\S]*?<\/form>/g)??[];
  const form=forms.find(form=>form.includes('name="name"')&&form.includes('name="template"'));assert.ok(form,'Rendered create-space form');
  const actionId=form.match(/name="(\$ACTION_ID_[^"]+)"/)?.[1];assert.ok(actionId,'Real compiled create-space action');
  const defaultInput=(form.match(/<input\b[^>]*>/g)??[]).find(input=>input.includes('name="template"')&&(input.includes('type="hidden"')||input.includes('checked=""')));
  assert.ok(defaultInput?.includes('value="blank"'),'Initial selected template remains blank');checks++;
  const escaped=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#x27;');
  for(const template of catalog){assert.ok(html.includes(escaped(template.name)),`Catalog name rendered: ${template.name}`);checks++;}
  const post=async(who,values)=>{const body=new FormData();for(const [key,value] of Object.entries({[actionId]:'',...values}))body.set(key,String(value));const result=await request('/new',who,{method:'POST',headers:{origin:base},body});await result.text();assert.equal(result.status,303,lastRequest);checks++;return result;};
  for(const who of [null,'agent']){const before=snapshot();await post(who,{name:'Denied fixture',template:'blank',visibility:'private'});assert.equal(snapshot(),before,'unchanged baseline refuses creation for this fixture role');checks++;}
  // Submit the unchanged server action for each real template, not a replacement test implementation.
  for(const template of TEMPLATES){
    const result=await post('owner',{name:'HTTP '+template.id,description:'Synthetic chooser fixture',template:template.id,visibility:'private'});
    const location=result.headers.get('location'),space=data.getSpaceBySlug(location.split('/')[1]);assert.ok(space);assert.equal(space.kind,template.kind);assert.equal(space.visibility,'private');
    const rows=db.prepare('SELECT * FROM pages WHERE space_id=? ORDER BY position,id').all(space.id);
    assert.equal(rows.length,catalog.find(t=>t.id===template.id).pageCount);assert.ok(rows.every(row=>row.published===0),'Template creation stays draft');
    const match=(pages,parentId=null)=>{const children=rows.filter(row=>row.parent_id===parentId).sort((a,b)=>a.position-b.position);assert.equal(children.length,pages.length);for(let i=0;i<pages.length;i++){assert.equal(children[i].title,pages[i].title.trim()||'Untitled');assert.deepEqual(JSON.parse(children[i].content),pages[i].blocks);match(pages[i].children??[],children[i].id);checks++;}};
    match(template.pages);
    assert.equal(db.prepare('SELECT role FROM space_members WHERE space_id=? AND user_id=?').get(space.id,'owner').role,'admin');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM pages_fts WHERE page_id IN (SELECT id FROM pages WHERE space_id=?)').get(space.id).n,0);checks++;
  }
  // Omitting the chooser field retains the existing action default.
  const fallback=await post('owner',{name:'HTTP omitted template',visibility:'private'});const fallbackSpace=data.getSpaceBySlug(fallback.headers.get('location').split('/')[1]);assert.equal(db.prepare('SELECT COUNT(*) n FROM pages WHERE space_id=?').get(fallbackSpace.id).n,TEMPLATES.find(t=>t.id==='blank').pages.length);checks++;
  console.log(`${checks} template chooser compiled HTTP checks passed (actual sessions/forms/action, isolated SQLite)`);
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
