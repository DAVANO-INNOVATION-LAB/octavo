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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-source-matches-http-'));
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
  const bytes='# Exact original source\n\nSynthetic body';
  const fileForm=(filename,content=bytes)=>{const form=new FormData();form.set('file',new Blob([content]),filename);form.set('name','Original fixture');return form;};
  const uploaded=await request('/api/import','owner',{method:'POST',body:fileForm('original.md')});assert.equal(uploaded.status,303);
  const space=data.getSpaceBySlug(uploaded.headers.get('location').slice(1));assert.ok(space);
  const original=db.prepare('SELECT report_json FROM import_reports WHERE space_id=?').get(space.id).report_json;
  const snapshot=()=>JSON.stringify(['spaces','pages','uploads','import_reports','import_idempotency'].map(t=>db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
  const preview=async(who='owner',content=bytes,filename='renamed.md',status=200)=>{
    const response=await request('/api/import/preview',who,{method:'POST',body:fileForm(filename,content)});assert.equal(response.status,status);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.match(response.headers.get('vary'),/Cookie/);checks++;
    return response.json();
  };
  const before=snapshot(),matched=await preview();assert.equal(matched.sourceMatches.status,'complete');assert.equal(matched.sourceMatches.candidates.length,1);
  assert.equal(matched.sourceMatches.candidates[0].spaceSlug,space.slug);assert.equal(matched.sourceMatches.candidates[0].sourceLabel,'original.md');assert.equal(snapshot(),before);checks+=5;
  const modified=await preview('owner',bytes+' changed');assert.equal(modified.sourceMatches.candidates.length,0);checks++;
  const page=db.prepare('SELECT id FROM pages WHERE space_id=?').get(space.id);data.savePage(page.id,{content:'Edited output is not source identity'});
  assert.equal((await preview()).sourceMatches.candidates.length,1);checks++;
  for(const [who,role]of[['editor','editor'],['reader','reader'],['agent','agent']])roles.setSpaceMember(space.id,who,role);
  for(const who of ['editor','reader','outsider']){const result=await preview(who);assert.equal(result.sourceMatches.candidates.length,0);assert.ok(!JSON.stringify(result).includes(space.slug));checks+=2;}
  assert.equal((await preview('admin')).sourceMatches.candidates.length,1);checks++;
  const unauth=await preview(null,bytes,'renamed.md',403);assert.equal(unauth.sourceMatches,undefined);checks++;
  roles.setSpaceMember(space.id,'owner','reader');assert.equal((await preview()).sourceMatches.candidates.length,0);checks++;roles.setSpaceMember(space.id,'owner','admin');
  db.prepare('UPDATE import_reports SET report_json=? WHERE space_id=?').run('{bad-json',space.id);
  const bad=await preview();assert.equal(bad.sourceMatches.status,'limited');assert.equal(bad.sourceMatches.candidates.length,0);checks+=2;
  const legacy=JSON.parse(original);delete legacy.provenance;db.prepare('UPDATE import_reports SET report_json=? WHERE space_id=?').run(JSON.stringify(legacy),space.id);
  assert.equal((await preview()).sourceMatches.candidates.length,0);checks++;
  db.prepare('UPDATE import_reports SET report_json=? WHERE space_id=?').run(original,space.id);
  db.prepare('INSERT INTO deleted_spaces(space_id,deleted_at,deleted_by) VALUES(?,?,?)').run(space.id,Date.now(),'owner');assert.equal((await preview()).sourceMatches.candidates.length,0);checks++;
  console.log(`PASS compiled exact-source preview: ${checks} checks, synthetic only`);

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
