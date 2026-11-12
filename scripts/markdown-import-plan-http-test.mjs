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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-markdown-import-plan-http-'));
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
  const data = require('../src/lib/data.ts'), tenants = require('../src/lib/tenants.ts');
  for (const name of ['owner', 'reader', 'outsider', 'excluded', 'admin', 'agent']) {
    db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(name, `${name}@example.test`, name, '!', name === 'agent' ? 'agent' : name === 'admin' ? 'admin' : 'member', Date.now());
    db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run(`synthetic-${name}`, name, Date.now() + 86400000);
  }
  const tenant = tenants.createTenant('HTTP tenant');
  tenants.addMember(tenant.id, 'owner'); tenants.addMember(tenant.id, 'reader');
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
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (attempt >= 100 || server.exitCode !== null) throw new Error(`Test server failed: ${fs.readFileSync(logPath, 'utf8')}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  // Throw rather than exit on a stale build, so finally always stops the server.
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.version, JSON.parse(fs.readFileSync('package.json', 'utf8')).version, 'Rebuild first: compiled server must match checkout version');
  const request = (url, who, options = {}) => {
    lastRequest = `${options.method ?? 'GET'} ${url} actor=${who ?? 'anonymous'}`;
    return fetch(`${base}${url}`, { redirect: 'manual', ...options,
      headers: { connection: 'close', ...(who ? { cookie: `octavo_session=synthetic-${who}` } : {}), ...options.headers } });
  };
  let checks = 0;

  const {zip}=require('../src/lib/zip.ts');const {UPLOADS_DIR}=require('../src/lib/db.ts');
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='users' ORDER BY name").all().map(r=>r.name);
  const snapshot=()=>JSON.stringify(tables.map(name=>[name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all().map(row=>JSON.stringify(row)).sort()]));
  const disk=()=>fs.existsSync(UPLOADS_DIR)?JSON.stringify(fs.readdirSync(UPLOADS_DIR).sort().map(name=>[name,fs.readFileSync(path.join(UPLOADS_DIR,name)).toString('base64')])):'[]';
  const form=(bytes,name,digest)=>{const f=new FormData();f.set('name',name);f.set('file',new Blob([bytes]),'plan.zip');if(digest)f.set('previewDigest',digest);return f;};
  const cases=[
    ['Structured Markdown',[
      {name:'bundle/index.md',data:Buffer.from('# Platform guide\n\n[Notes](README.md)')},
      {name:'bundle/README.md',data:Buffer.from('---\npublished: false\n---\n# Release notes\n\nDraft release details.')},
      {name:'bundle/cluster/index.md',data:Buffer.from('# Cluster guide\n\n[Notes](README.md)')},
      {name:'bundle/cluster/README.md',data:Buffer.from('# Cluster notes\n\nOperational details.')},
      {name:'bundle/orphan/docs/worker.md',data:Buffer.from('# Worker instructions\n\nActual worker body.\n\n[Binary](../../data.bin)')},
      {name:'bundle/data.bin',data:Buffer.from([0,255,123,10])},
    ]],
    ['Structured Notion',[
      {name:'Root 11111111111111111111111111111111.md',data:Buffer.from('# Notion actual heading\n\nStatus: Ready\n\n[Next](Target%2022222222222222222222222222222222.md)')},
      {name:'Target 22222222222222222222222222222222.md',data:Buffer.from('# Notion target heading\n\nActual destination.')},
    ]],
  ];
  for(const [name,entries] of cases){
    const bytes=zip(entries),before=snapshot(),filesBefore=disk();
    const previewResponse=await request('/api/import/preview','owner',{method:'POST',body:form(bytes,name)});assert.equal(previewResponse.status,200);const preview=await previewResponse.json();assert.deepEqual(preview.errors,[]);
    assert.equal(snapshot(),before,'Planning never writes application tables');assert.equal(disk(),filesBefore,'Planning never writes files');checks++;
    assert.equal(new Set(preview.pages.map(p=>p.title)).size,preview.pages.length,'Unique synthetic fixture titles');
    for(const [index,page] of preview.pages.entries()){
      assert.equal(typeof page.published,'boolean');assert.equal(typeof page.generated,'boolean');
      assert.ok(page.parentIndex===null||(Number.isInteger(page.parentIndex)&&page.parentIndex>=0&&page.parentIndex<preview.pages.length&&page.parentIndex!==index));
      if(!page.generated)assert.ok(entries.some(e=>e.name===page.sourcePath),'Original source archive path retained');
      else{assert.equal(page.published,false);assert.ok(!page.sourcePath,'Generated folder has no source document');}
      assert.ok(Number.isInteger(page.blocks)&&page.blocks>=0);checks++;
    }
    if(name==='Structured Markdown'){
      assert.equal(preview.pages.length,7);assert.equal(preview.pages.filter(p=>p.generated).length,2);
      assert.equal(preview.pages.find(p=>p.title==='Release notes').published,false);
      assert.equal(preview.pages.find(p=>p.title==='Release notes').parentIndex,preview.pages.findIndex(p=>p.title==='Platform guide'));
      assert.equal(preview.pages.find(p=>p.title==='Cluster notes').parentIndex,preview.pages.findIndex(p=>p.title==='Cluster guide'));
      assert.deepEqual(preview.assetPlan,{files:1,bytes:4});checks++;
    }
    const imported=await request('/api/import','owner',{method:'POST',body:form(bytes,name,preview.digest)});assert.equal(imported.status,303);const location=imported.headers.get('location');assert.ok(location&&!location.includes('error='),location);
    const space=data.getSpaceBySlug(location.slice(1));assert.ok(space);const saved=db.prepare('SELECT * FROM pages WHERE space_id=?').all(space.id);assert.equal(saved.length,preview.pages.length);
    const byTitle=new Map(saved.map(p=>[p.title,p]));
    for(const planned of preview.pages){const actual=byTitle.get(planned.title);assert.ok(actual,planned.title);assert.equal(actual.published,Number(planned.published));assert.equal(actual.parent_id,planned.parentIndex===null?null:byTitle.get(preview.pages[planned.parentIndex].title).id);assert.equal(JSON.parse(actual.content).length,planned.blocks);checks++;}
    const receiptResponse=await request(`/api/spaces/${space.slug}/import-report`,'owner');assert.equal(receiptResponse.status,200);const receipt=await receiptResponse.json();assert.equal(receipt.preview.pages,preview.pages.length);assert.equal(receipt.counts.pages,preview.pages.length);assert.ok(!receipt.warnings.some(w=>w.includes('Preview estimated')));checks++;
  }
  console.log(`PASS compiled shared Markdown plan: ${checks} read-only-preview/source/hierarchy/status/generated/Notion/import-parity/receipt checks using isolated synthetic data.`);

} catch (error) {
  await new Promise(resolve => setTimeout(resolve, 100));
  console.error(`HTTP fixture failed at ${lastRequest}; server exit=${server?.exitCode} signal=${server?.signalCode}`);
  if (logPath && fs.existsSync(logPath)) console.error(fs.readFileSync(logPath, 'utf8').slice(-6000));
  throw error;
} finally {
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
  db?.close();
  Module._load = originalLoad;
  if (originalTs) Module._extensions['.ts'] = originalTs; else delete Module._extensions['.ts'];
  fs.rmSync(temporary, { recursive: true, force: true });
}
