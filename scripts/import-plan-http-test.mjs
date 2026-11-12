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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-import-plan-http-'));
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

  const {zip}=require('../src/lib/zip.ts');
  const {UPLOADS_DIR}=require('../src/lib/db.ts');
  const asset=Buffer.from([0,255,128,65,66,67,10,13,5,6,7]);
  const archive=zip([
    {name:'guide.md',data:Buffer.from('# Plan fixture\n\n![first](assets/chart.png)\n\n![again](assets/chart.png#again)')},
    {name:'assets/chart.png',data:asset},
    {name:'assets/unused.png',data:Buffer.from('Never referenced')},
  ]);
  const form=(filename,bytes,digest)=>{const f=new FormData();f.set('name','Import plan HTTP');f.set('file',new Blob([bytes]),filename);if(digest)f.set('previewDigest',digest);return f;};
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'users' ORDER BY name").all().map(r=>r.name);
  const snapshot=()=>JSON.stringify(tables.map(name=>[name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all().map(row=>JSON.stringify(row)).sort()]));
  const files=()=>fs.existsSync(UPLOADS_DIR)?fs.readdirSync(UPLOADS_DIR).sort():[];
  const before=snapshot(),filesBefore=files();
  for(const who of [null,'agent']){
    const response=await request('/api/import/preview',who,{method:'POST',body:form('assets.zip',archive)});
    assert.equal(response.status,403);await response.arrayBuffer();checks++;
  }
  const previewResponse=await request('/api/import/preview','owner',{method:'POST',body:form('assets.zip',archive)});
  assert.equal(previewResponse.status,200);const preview=await previewResponse.json();
  assert.deepEqual(preview.errors,[]);assert.equal(preview.attachments,2);assert.equal(preview.pages.length,1);
  assert.deepEqual(preview.assetPlan,{files:1,bytes:asset.length});assert.match(preview.digest,/^[a-f0-9]{64}$/);checks++;
  assert.equal(snapshot(),before,'Preview and denied preview do not write application state');assert.deepEqual(files(),filesBefore,'Preview never copies assets');checks++;
  const textResponse=await request('/api/import/preview','owner',{method:'POST',body:form('plain.md',Buffer.from('# Plain document'))});
  assert.equal(textResponse.status,200);assert.equal(Object.hasOwn(await textResponse.json(),'assetPlan'),false,'Non-ZIP previews remain backward compatible');checks++;
  const mismatch=await request('/api/import','owner',{method:'POST',body:form('assets.zip',archive,'0'.repeat(64))});
  assert.equal(mismatch.status,303);assert.match(mismatch.headers.get('location'),/error=/);assert.equal(snapshot(),before);assert.deepEqual(files(),filesBefore);checks++;
  const response=await request('/api/import','owner',{method:'POST',body:form('assets.zip',archive,preview.digest)});
  assert.equal(response.status,303);const location=response.headers.get('location');assert.ok(location&&!location.includes('error='),location);
  const space=data.getSpaceBySlug(location.slice(1));assert.ok(space);checks++;
  const reportResponse=await request(`/api/spaces/${space.slug}/import-report`,'owner');assert.equal(reportResponse.status,200);
  const receipt=await reportResponse.json();assert.deepEqual(receipt.preview.assetPlan,preview.assetPlan);
  assert.equal(receipt.preview.attachmentEntries,2);assert.equal(receipt.counts.attachmentsSaved,1);
  const uploads=db.prepare('SELECT * FROM uploads WHERE space_id=?').all(space.id);assert.equal(uploads.length,1);
  assert.deepEqual(fs.readFileSync(path.join(UPLOADS_DIR,uploads[0].name)),asset);assert.equal(files().length,1);checks++;
  const again=await request('/api/import/preview','owner',{method:'POST',body:form('assets.zip',archive)});
  assert.equal(again.status,200);assert.deepEqual((await again.json()).assetPlan,preview.assetPlan);assert.equal(files().length,1);checks++;
  console.log(`PASS compiled import plan: ${checks} auth/preview/no-write/digest/confirmation/receipt/dedup/byte checks using isolated synthetic data.`);

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
