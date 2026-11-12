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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-import-history-http-'));
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

  const roles=require('../src/lib/roles.ts');
  const reports=require('../src/lib/import-reports.ts');
  const get=async(who,query='')=>{const r=await request('/import/history'+query,who);const html=await r.text();checks++;return {r,html};};
  const anonymous=await get(null);assert.equal(anonymous.r.status,307);assert.match(anonymous.r.headers.get('location'),/\/login/);
  const empty=await get('owner');assert.equal(empty.r.status,200);assert.match(empty.html,/No import reports to show/i);
  const fixtures=[];
  const fixture=(label,who='owner',visibility='private')=>{
    const space=data.createSpace({name:label,visibility});roles.setSpaceMember(space.id,who,'admin');
    const page=data.createPage({spaceId:space.id,title:label+' page'});data.savePage(page.id,{published:true});
    const report=db.transaction(()=>reports.createImportReport({spaceId:space.id,actorId:who,sourceKind:'upload',sourceLabel:label+'.md',preview:{pages:1,attachmentEntries:0,warnings:label==='Visible-20'?['Review the synthetic external reference.']:[]}}))();
    const completedAt=1700000000000+fixtures.length*1000;report.completedAt=completedAt;
    db.prepare('UPDATE import_reports SET completed_at=?,report_json=? WHERE id=?').run(completedAt,JSON.stringify({...report,actorId:null}),report.id);
    const item={space,page,report,label};fixtures.push(item);return item;
  };
  const visible=Array.from({length:21},(_,i)=>fixture(`Visible-${String(i).padStart(2,'0')}`));
  assert.deepEqual(visible[20].report.warnings,['Review the synthetic external reference.'],'UI fixture warning count is exactly one');
  const privateOther=fixture('HIDDEN-private','outsider');
  const publicOther=fixture('HIDDEN-public','outsider','public');
  const revoked=fixture('HIDDEN-revoked');roles.removeSpaceMember(revoked.space.id,'owner');
  const deleted=fixture('HIDDEN-deleted');db.prepare('INSERT INTO deleted_spaces(space_id,deleted_at,deleted_by) VALUES(?,?,?)').run(deleted.space.id,Date.now(),'owner');
  const tenantOther=fixture('HIDDEN-tenant');tenants.setSpaceTenant(tenantOther.space.id,tenant.id);tenants.removeMember(tenant.id,'owner');
  // An old receipt has no assetPlan. Current page edits must not rewrite it.
  const old=visible[0];data.createPage({spaceId:old.space.id,title:'Added after import'});data.savePage(old.page.id,{published:false});
  for(const item of visible)roles.setSpaceMember(item.space.id,'reader','reader');
  const first=await get('owner');assert.equal(first.r.status,200);
  assert.equal((first.html.match(/<article\b/g)||[]).length,20);
  for(const item of visible.slice(1))assert.ok(first.html.includes(item.label+'.md'),item.label);
  assert.ok(!first.html.includes('Visible-00.md'));assert.ok(!first.html.includes('HIDDEN-'));
  const older=await get('owner','?page=2');assert.equal(older.r.status,200);
  assert.equal((older.html.match(/<article\b/g)||[]).length,1);assert.ok(older.html.includes('Visible-00.md'));assert.ok(!older.html.includes('Visible-01.md'));assert.ok(!older.html.includes('HIDDEN-'));
  const oldReceipt=await request(`/api/spaces/${old.space.slug}/import-report`,'owner');assert.equal(oldReceipt.status,200);const saved=await oldReceipt.json();assert.equal(saved.counts.pages,1);assert.equal(saved.counts.published,1);assert.equal(saved.preview.assetPlan,undefined);checks++;
  for(const who of ['reader','agent']){const denied=await get(who);assert.equal(denied.r.status,200);assert.ok(!denied.html.includes('Visible-'));assert.ok(!denied.html.includes('HIDDEN-'));}
  const outsider=await get('outsider');assert.ok(outsider.html.includes(privateOther.label+'.md'));assert.ok(outsider.html.includes(publicOther.label+'.md'));assert.ok(!outsider.html.includes('Visible-'));
  const admin=await get('admin');assert.ok(admin.html.includes('HIDDEN-tenant.md'));assert.ok(!admin.html.includes('HIDDEN-deleted.md'));
  for(const offset of ['0','-1','oops','1.5']){const invalid=await get('owner','?page='+offset);assert.equal(invalid.r.status,200);assert.ok(invalid.html.includes('Visible-20.md'));assert.ok(!invalid.html.includes('Visible-00.md'));}
  const far=await get('owner','?page=999');assert.equal(far.r.status,200);assert.ok(!far.html.includes('Visible-'));assert.ok(!far.html.includes('HIDDEN-'));
  roles.removeSpaceMember(visible[20].space.id,'owner');const lost=await get('owner');assert.ok(!lost.html.includes('Visible-20.md'));assert.ok(lost.html.includes('Visible-00.md'),'Pagination fills from current accessible reports');
  tenants.addMember(tenant.id,'owner');const gained=await get('owner');assert.ok(gained.html.includes('HIDDEN-tenant.md'),'Current tenant membership restores authorized report');
  console.log(`PASS compiled import history: ${checks} sign-in/empty/access/pagination/legacy-snapshot/revocation/tenant checks using isolated synthetic data.`);

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
