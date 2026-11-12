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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-import-report-http-'));
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
  let checks = 0;

  const upload = async (filename, bytes, name) => {
    const form = new FormData(); form.set('name', name); form.set('file', new Blob([bytes]), filename);
    const response = await request('/api/import', 'owner', {method:'POST',body:form});
    assert.equal(response.status,303); checks++;
    return response.headers.get('location');
  };
  const reportFor = async (space, who, expected = 200) => {
    const response = await request(`/api/spaces/${space.slug}/import-report`,who);
    assert.equal(response.status,expected,lastRequest);
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    assert.match(response.headers.get('vary'),/Cookie/); checks++;
    if(expected!==200){assert.equal(await response.text(),'Not found');return null;}
    assert.match(response.headers.get('content-disposition'),/attachment/);
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    return response.json();
  };
  const {zip} = require('../src/lib/zip.ts');
  const archived = zip([{name:'root.md',data:Buffer.from('# Root fixture')},{name:'nested/guide.md',data:Buffer.from('# Synthetic guide\n\n![image](photo.png)')},{name:'nested/photo.png',data:Buffer.from('synthetic bytes')}]);
  const archiveLocation=await upload('guide.zip',archived,'Synthetic archive report');
  assert.ok(!archiveLocation.includes('error='));
  const archiveSpace=data.getSpaceBySlug(archiveLocation.slice(1)); assert.ok(archiveSpace);
  const archiveReport=await reportFor(archiveSpace,'owner');
  assert.equal(archiveReport.source.kind,'upload');assert.equal(archiveReport.source.label,'guide.zip');
  assert.equal(archiveReport.preview.pages,2);assert.equal(archiveReport.preview.attachmentEntries,1);
  assert.equal(archiveReport.counts.attachmentsSaved,0);assert.ok(archiveReport.counts.drafts>0);
  assert.ok(archiveReport.warnings.some(w=>w.includes('relative')));assert.ok(archiveReport.warnings.some(w=>w.includes('Preview estimated')));checks++;
  const persisted=db.prepare('SELECT COUNT(*) n FROM pages WHERE space_id=?').get(archiveSpace.id).n;
  assert.equal(archiveReport.counts.pages,persisted);
  const oldSnapshot=JSON.stringify(archiveReport);
  const first=db.prepare('SELECT id FROM pages WHERE space_id=? AND published=1').get(archiveSpace.id);
  data.savePage(first.id,{published:false,title:'Changed after import'});
  assert.equal(JSON.stringify(await reportFor(archiveSpace,'owner')),oldSnapshot,'Receipt is an immutable completion snapshot');checks++;
  const formResponse=await request('/import/openapi','owner');assert.equal(formResponse.status,200);
  const markup=(await formResponse.text()).match(/<form\b[\s\S]*?<\/form>/g)?.find(f=>f.includes('name="spec"'));
  const actionId=markup?.match(/name="(\$ACTION_ID_[^"]+)"/)?.[1];assert.ok(actionId);
  const form=new FormData();form.set(actionId,'');form.set('name','Synthetic API report');form.set('spec',JSON.stringify({openapi:'3.0.3',info:{title:'Fixture',version:'1'},paths:{'/fixture':{get:{summary:'Fixture operation',responses:{'200':{description:'OK'}}}}}}));
  const response=await request('/import/openapi','owner',{method:'POST',headers:{origin:base},body:form});assert.equal(response.status,303);
  const apiSpace=data.getSpaceBySlug(new URL(response.headers.get('location'),base).pathname.slice(1));assert.ok(apiSpace);
  const apiReport=await reportFor(apiSpace,'owner');assert.equal(apiReport.source.kind,'openapi');assert.equal(apiReport.counts.pages,apiReport.counts.indexed);assert.ok(apiReport.notes.some(n=>n.includes('not a lossless')));checks++;
  for(const space of [archiveSpace,apiSpace]){
    for(const [who,role] of [['editor','editor'],['reader','reader'],['agent','agent'],['excluded','admin']])roles.setSpaceMember(space.id,who,role);
    for(const visibility of ['private','public','tenant']){
      data.updateSpace(space.id,{visibility:visibility==='private'?'private':'public'});tenants.setSpaceTenant(space.id,visibility==='tenant'?tenant.id:null);
      for(const who of [null,'owner','editor','reader','outsider','agent','excluded','admin']){
        const allowed=who==='owner'||who==='admin'||(who==='excluded'&&visibility!=='tenant');
        await reportFor(space,who,allowed?200:404);
        const page=await request(`/${space.slug}/settings/import-report`,who);const html=await page.text();
        assert.equal(page.status,allowed?200:who?404:307,lastRequest);
        if(allowed){assert.ok(html.includes('Snapshot at import completion'));assert.ok(html.includes('Download JSON'));}
        else {assert.ok(!html.includes('guide.zip'));assert.ok(!html.includes('Preview estimated'));}
        checks++;
      }
    }
    roles.removeSpaceMember(space.id,'owner');await reportFor(space,'owner',404);
    db.prepare('INSERT INTO deleted_spaces(space_id,deleted_at,deleted_by) VALUES(?,?,?)').run(space.id,Date.now(),'admin');await reportFor(space,'admin',404);
  }
  const historical=data.createSpace({name:'Historical no receipt',visibility:'private'});roles.setSpaceMember(historical.id,'owner','admin');
  await reportFor(historical,'owner',404);
  const noReport=await request(`/${historical.slug}/settings/import-report`,'owner');assert.equal(noReport.status,200);assert.match(await noReport.text(),/No saved import report/i);checks++;
  const snapshot=()=>JSON.stringify(['spaces','pages','uploads','pages_fts','import_reports','space_members'].map(t=>db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));const before=snapshot();
  db.exec("CREATE TRIGGER fail_import_receipt BEFORE INSERT ON import_reports BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
  try {assert.match(await upload('failed.md','# Failed receipt','Failed receipt'),/error=/);assert.equal(snapshot(),before);checks++;}finally{db.exec('DROP TRIGGER fail_import_receipt');}
  console.log(`PASS compiled import reports: ${checks} form/upload/report/access/snapshot/rollback checks using isolated synthetic data.`);

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
