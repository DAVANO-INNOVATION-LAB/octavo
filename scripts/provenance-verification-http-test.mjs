// Compiled Next HTTP smoke. Run npm run build first. Uses an isolated database and loopback server.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import Module, { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-provenance-verification-http-'));
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
  const data = require('../src/lib/data.ts'), roles = require('../src/lib/roles.ts'), tenants = require('../src/lib/tenants.ts');
  for (const name of ['owner', 'editor', 'reader', 'outsider', 'agent', 'excluded', 'admin']) {
    db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(name, `${name}@example.test`, name, '!', name === 'agent' ? 'agent' : name === 'admin' ? 'admin' : 'member', Date.now());
    db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run(`synthetic-${name}`, name, Date.now() + 86400000);
  }
  const tenant = tenants.createTenant('HTTP tenant');
  tenants.addMember(tenant.id, 'owner'); tenants.addMember(tenant.id, 'reader'); tenants.addMember(tenant.id, 'agent');
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
  const { requireTarget } = await import('./target.mjs');
  await requireTarget(base);
  const request = (url, who, options = {}) => {
    lastRequest = `${options.method ?? 'GET'} ${url} actor=${who ?? 'anonymous'}`;
    return fetch(`${base}${url}`, { redirect: 'manual', ...options,
      headers: { connection: 'close', ...(who ? { cookie: `octavo_session=synthetic-${who}` } : {}), ...options.headers } });
  };
  let checks=0;
  const {zip}=require('../src/lib/zip.ts');
  const bytes=zip([{name:'guide.md',data:Buffer.from('# Synthetic guide\n\n![asset](photo.png)')},{name:'photo.png',data:Buffer.from('synthetic image')}]);
  const form=new FormData();form.set('file',new Blob([bytes]),'verification.zip');form.set('name','Verification fixture');
  const imported=await request('/api/import','owner',{method:'POST',body:form});assert.equal(imported.status,303);
  const space=data.getSpaceBySlug(imported.headers.get('location').slice(1));assert.ok(space);
  const endpoint=`/api/spaces/${space.slug}/import-report/verify`;
  const verify=async(who='owner',origin=base,expected=200)=>{
    const response=await request(endpoint,who,{method:'POST',headers:{...(origin===null?{}:{origin})}});
    assert.equal(response.status,expected,lastRequest);assert.equal(response.headers.get('cache-control'),'private, no-store');checks++;
    return response.json();
  };
  const receiptBefore=db.prepare('SELECT report_json FROM import_reports WHERE space_id=?').get(space.id).report_json;
  const original=JSON.parse(receiptBefore);
  const clean=await verify();assert.equal(clean.status,'checked');assert.equal(clean.pages.length,original.provenance.pages.length);assert.equal(clean.attachments.length,1);
  assert.ok(clean.pages.every(p=>p.status==='unchanged'));assert.equal(clean.attachments[0].status,'unchanged');
  assert.equal(clean.source.status,'not_checked');checks+=6;
  const pageId=original.provenance.pages[0].pageId;
  db.prepare('UPDATE pages SET content=? WHERE id=?').run('changed synthetic content',pageId);
  const uploadName=original.provenance.attachments[0].name;
  const uploadFile=path.join(temporary,'data/uploads',uploadName);fs.writeFileSync(uploadFile,'changed synthetic image');
  const changed=await verify();assert.equal(changed.pages.find(p=>p.pageId===pageId).status,'changed');assert.equal(changed.attachments[0].status,'changed');checks+=2;
  const other=data.createSpace({name:'Outside verification',visibility:'private'});
  db.prepare('UPDATE pages SET space_id=? WHERE id=?').run(other.id,pageId);
  db.prepare('UPDATE uploads SET space_id=? WHERE name=?').run(other.id,uploadName);
  const moved=await verify();assert.equal(moved.pages.find(p=>p.pageId===pageId).status,'missing');assert.equal(moved.attachments[0].status,'missing');checks+=2;
  assert.equal(db.prepare('SELECT report_json FROM import_reports WHERE space_id=?').get(space.id).report_json,receiptBefore);checks++;
  for(const [who,role]of[['editor','editor'],['reader','reader'],['agent','agent']])roles.setSpaceMember(space.id,who,role);
  for(const who of [null,'reader','editor','outsider','agent']){
    const denied=await verify(who,base,404);assert.ok(!JSON.stringify(denied).includes(original.provenance.source.sha256));
  }
  await verify('owner','https://wrong-origin.example',403);await verify('owner',null,403);
  const method=await request(endpoint,'owner');assert.equal(method.status,405);checks++;
  const legacy={...original};delete legacy.provenance;
  db.prepare('UPDATE import_reports SET report_json=? WHERE space_id=?').run(JSON.stringify(legacy),space.id);
  const unavailable=await verify();assert.equal(unavailable.status,'unavailable');assert.equal(unavailable.pages.length,0);checks+=2;
  db.prepare('UPDATE import_reports SET report_json=? WHERE space_id=?').run('{malformed',space.id);
  assert.equal((await verify()).status,'unavailable');checks++;
  console.log(`PASS compiled provenance verification: ${checks} checks, synthetic only`);

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
