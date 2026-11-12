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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-markdown-index-collision-http-'));
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
  for (const name of ['owner', 'reader', 'outsider', 'excluded', 'admin']) {
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
  const rootBytes=Buffer.from([0,255,1,2,13,10]),nestedBytes=Buffer.from([128,0,3,4,10]);
  const entries=[
    {name:'bundle/index.md',data:Buffer.from('# Root overview\n\nROOT INDEX CONTENT\n\n[Root notes](README.md)\n\n[Cluster](cluster/index.md)\n\n[Root data](data.bin)')},
    {name:'bundle/README.md',data:Buffer.from('---\npublished: false\n---\n# Root notes\n\nROOT README CONTENT\n\n[Overview](index.md)')},
    {name:'bundle/cluster/index.md',data:Buffer.from('# Cluster overview\n\nNESTED INDEX CONTENT\n\n[Cluster notes](README.md)\n\n[Root](../index.md)\n\n[Cluster data](data.bin)')},
    {name:'bundle/cluster/README.md',data:Buffer.from('# Cluster notes\n\nNESTED README CONTENT\n\n[Overview](index.md)')},
    {name:'bundle/data.bin',data:rootBytes},{name:'bundle/cluster/data.bin',data:nestedBytes},
  ];
  const archive=zip(entries);
  const upload=async(name,bytes=archive)=>{const form=new FormData();form.set('name',name);form.set('file',new Blob([bytes]),'collision.zip');const r=await request('/api/import','owner',{method:'POST',body:form});assert.equal(r.status,303);checks++;return r.headers.get('location');};
  const hrefs=row=>{const found=[];const walk=value=>{if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object'){if(value.type==='link')found.push(value.href);Object.values(value).forEach(walk);}};walk(JSON.parse(row.content));return found;};
  const location=await upload('Index collision HTTP');assert.ok(location&&!location.includes('error='),location);
  const space=data.getSpaceBySlug(location.slice(1));assert.ok(space);
  const pages=db.prepare('SELECT * FROM pages WHERE space_id=?').all(space.id);
  const marker=body=>{const found=pages.filter(p=>p.content.includes(body));assert.equal(found.length,1,body);return found[0];};
  const root=marker('ROOT INDEX CONTENT'),notes=marker('ROOT README CONTENT'),nested=marker('NESTED INDEX CONTENT'),nestedNotes=marker('NESTED README CONTENT');
  assert.equal(new Set([root,notes,nested,nestedNotes].map(p=>p.id)).size,4);assert.equal(new Set([root,notes,nested,nestedNotes].map(p=>p.slug)).size,4);assert.equal(pages.length,4,'Both documents retained without surplus placeholder pages');
  assert.equal(root.parent_id,null);assert.equal(notes.parent_id,root.id);assert.equal(nested.parent_id,root.id);assert.equal(nestedNotes.parent_id,nested.id);
  const dest=p=>`/${space.slug}/${p.slug}`;
  assert.equal(notes.published,0);assert.equal(root.published,1);assert.equal(nested.published,1);assert.equal(nestedNotes.published,1);
  assert.deepEqual(hrefs(root).filter(h=>!h.startsWith('/api/files/')),[dest(notes),dest(nested)]);
  assert.deepEqual(hrefs(notes),[dest(root)]);assert.deepEqual(hrefs(nested).filter(h=>!h.startsWith('/api/files/')),[dest(nestedNotes),dest(root)]);assert.deepEqual(hrefs(nestedNotes),[dest(nested)]);checks++;
  for(const [p,body] of [[root,'ROOT INDEX CONTENT'],[notes,'ROOT README CONTENT'],[nested,'NESTED INDEX CONTENT'],[nestedNotes,'NESTED README CONTENT']]){const r=await request(dest(p),'owner');assert.equal(r.status,200);assert.ok((await r.text()).includes(body));checks++;}
  roles.setSpaceMember(space.id,'reader','reader');
  for(const p of [root,notes,nested,nestedNotes]){const r=await request(dest(p),'reader');assert.equal(r.status,p===notes?404:200);const body=await r.text();if(p===notes)assert.ok(!body.includes('ROOT README CONTENT'));checks++;}
  const rootFile=hrefs(root).find(h=>h.startsWith('/api/files/')),nestedFile=hrefs(nested).find(h=>h.startsWith('/api/files/'));assert.ok(rootFile&&nestedFile);assert.notEqual(rootFile,nestedFile);
  for(const [href,bytes] of [[rootFile,rootBytes],[nestedFile,nestedBytes]]){const r=await request(href,'owner');assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);checks++;}
  const receiptResponse=await request(`/api/spaces/${space.slug}/import-report`,'owner');assert.equal(receiptResponse.status,200);const receipt=await receiptResponse.json();assert.equal(receipt.counts.pages,4);assert.equal(receipt.counts.drafts,1);assert.equal(receipt.counts.attachmentsSaved,2);assert.ok(!receipt.warnings.some(w=>/relative link/i.test(w)));checks++;
  // ZIP entry ordering must not choose the README as primary.
  const reversedLoc=await upload('Reversed collision',zip([...entries].reverse()));const reversedSpace=data.getSpaceBySlug(reversedLoc.slice(1));assert.ok(reversedSpace);
  const reversedPages=db.prepare('SELECT * FROM pages WHERE space_id=?').all(reversedSpace.id);assert.equal(reversedPages.length,4);
  for(const body of ['ROOT INDEX CONTENT','ROOT README CONTENT','NESTED INDEX CONTENT','NESTED README CONTENT'])assert.equal(reversedPages.filter(p=>p.content.includes(body)).length,1);checks++;
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='users' ORDER BY name").all().map(r=>r.name);
  const snapshot=()=>JSON.stringify(tables.map(name=>[name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all().map(row=>JSON.stringify(row)).sort()]));
  const disk=()=>JSON.stringify(fs.readdirSync(UPLOADS_DIR).sort().map(name=>[name,fs.readFileSync(path.join(UPLOADS_DIR,name)).toString('base64')]));
  const before=snapshot(),filesBefore=disk();
  db.exec("CREATE TRIGGER fail_index_collision_receipt BEFORE INSERT ON import_reports BEGIN SELECT RAISE(ABORT,'synthetic collision receipt failure'); END");
  try{const failed=await upload('Rollback collision');assert.match(failed,/^\/import\?error=/);assert.equal(snapshot(),before);assert.equal(disk(),filesBefore);checks++;}finally{db.exec('DROP TRIGGER fail_index_collision_receipt');}
  console.log(`PASS compiled Markdown index collisions: ${checks} root/nested/bodies/links/drafts/assets/order/receipt/rollback checks using isolated synthetic data.`);

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
