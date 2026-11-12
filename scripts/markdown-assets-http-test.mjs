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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-markdown-assets-http-'));
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

  const {zip} = require('../src/lib/zip.ts');
  const {UPLOADS_DIR} = require('../src/lib/db.ts');
  const bytes = {
    left: Buffer.from([137,80,78,71,0,255,1,2,3]),
    right: Buffer.from([137,80,78,71,0,128,4,5,6]),
    report: Buffer.from('%PDF-1.4\nSynthetic attachment\n\x00\xff', 'latin1'),
    draft: Buffer.from([0,255,128,42,13,10]),
  };
  const archive = zip([
    {name:'bundle/left/page.md',data:Buffer.from('# Left fixture\n\n![left](photo.png?download=1#left)\n\n![again](./photo.png#duplicate)\n\n[report](../docs/report.pdf?download=1#p1)')},
    {name:'bundle/right/page.md',data:Buffer.from('# Right fixture\n\n![right](photo.png)')},
    {name:'bundle/drafts/page.md',data:Buffer.from('---\npublished: false\n---\n# Draft fixture\n\n[secret](secret.bin)')},
    {name:'bundle/left/photo.png',data:bytes.left},
    {name:'bundle/right/photo.png',data:bytes.right},
    {name:'bundle/docs/report.pdf',data:bytes.report},
    {name:'bundle/drafts/secret.bin',data:bytes.draft},
    {name:'bundle/unused.png',data:Buffer.from('Must never be copied')},
  ]);
  const upload = async name => {
    const form = new FormData(); form.set('name',name); form.set('file',new Blob([archive]),'assets.zip');
    const response = await request('/api/import','owner',{method:'POST',body:form});
    assert.equal(response.status,303,lastRequest);checks++;
    return response.headers.get('location');
  };
  const location = await upload('HTTP Markdown assets');
  assert.ok(location && !location.includes('error='), location);
  const space = data.getSpaceBySlug(location.slice(1)); assert.ok(space);
  assert.equal(space.visibility,'private');
  const page = title => {
    const row = db.prepare('SELECT * FROM pages WHERE space_id=? AND title=?').get(space.id,title);
    assert.ok(row,`Stored page ${title}`);return row;
  };
  const pages = {left:page('Left fixture'),right:page('Right fixture'),draft:page('Draft fixture')};
  const refs = row => {
    const found=[];
    const walk=value=>{
      if(typeof value==='string' && value.startsWith('/api/files/'))found.push(value);
      else if(Array.isArray(value))value.forEach(walk);
      else if(value && typeof value==='object')Object.values(value).forEach(walk);
    };
    walk(JSON.parse(row.content));return found;
  };
  const leftRefs = refs(pages.left), rightRefs=refs(pages.right), draftRefs=refs(pages.draft);
  assert.equal(leftRefs.length,3); assert.equal(rightRefs.length,1); assert.equal(draftRefs.length,1);
  const url = {
    left:leftRefs.find(r=>r.endsWith('?download=1#left')),
    duplicate:leftRefs.find(r=>r.endsWith('#duplicate')),
    report:leftRefs.find(r=>r.endsWith('?download=1#p1')),
    right:rightRefs[0],draft:draftRefs[0],
  };
  for(const ref of Object.values(url))assert.match(ref,/^\/api\/files\/[a-z0-9]+\.[a-z0-9]+(?:[?#].*)?$/);
  const pathname=ref=>new URL(ref,base).pathname;
  assert.equal(pathname(url.left),pathname(url.duplicate),'Duplicate source references share one generated upload');
  assert.notEqual(pathname(url.left),pathname(url.right),'Same basename in different directories stays distinct');
  assert.equal(pages.left.published,1);assert.equal(pages.right.published,1);assert.equal(pages.draft.published,0);
  const uploads=db.prepare('SELECT * FROM uploads WHERE space_id=? ORDER BY name').all(space.id);
  assert.equal(uploads.length,4,'Only referenced archive assets are attributed');
  const names=Object.keys(bytes).map(key=>path.basename(pathname(url[key]))).sort();
  assert.deepEqual(uploads.map(row=>row.name),names);
  for(const row of uploads){assert.equal(row.uploaded_by,'owner');assert.equal(row.space_id,space.id);}
  assert.deepEqual(fs.readdirSync(UPLOADS_DIR).sort(),names,'No unreferenced archive bytes copied');checks++;
  const reportResponse=await request(`/api/spaces/${space.slug}/import-report`,'owner');
  assert.equal(reportResponse.status,200);const receipt=await reportResponse.json();
  assert.equal(receipt.counts.attachmentsSaved,4);assert.equal(receipt.preview.attachmentEntries,5);checks++;
  const download = async (key, who, allowed) => {
    const response=await request(url[key],who);
    assert.equal(response.status,allowed?200:404,`${lastRequest} asset=${key}`);
    if(allowed){
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes[key],`Exact bytes: ${key}`);
      assert.equal(response.headers.get('cache-control'),'private, no-store');
      assert.match(response.headers.get('vary'),/Cookie/);
      assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    }else assert.equal(await response.text(),'not found');
    checks++;
  };
  roles.setSpaceMember(space.id,'reader','reader');roles.setSpaceMember(space.id,'excluded','admin');
  for(const who of ['owner','reader','outsider',null]){
    for(const key of Object.keys(bytes))await download(key,who,who==='owner'||(who==='reader'&&key!=='draft'));
  }
  // Revoking membership takes effect even with a previously downloaded, generated URL.
  roles.removeSpaceMember(space.id,'reader');await download('left','reader',false);
  roles.setSpaceMember(space.id,'reader','reader');await download('left','reader',true);
  roles.removeSpaceMember(space.id,'owner');await download('draft','owner',false);await download('left','owner',false);
  roles.setSpaceMember(space.id,'owner','admin');await download('draft','owner',true);
  data.updateSpace(space.id,{visibility:'public'});
  for(const who of ['owner','reader','outsider',null]){
    for(const key of Object.keys(bytes))await download(key,who,key!=='draft'||who==='owner');
  }
  // Removing the current publication revokes read access; history is not authority.
  data.savePage(pages.left.id,{published:false});
  for(const who of ['reader','outsider',null]){await download('left',who,false);await download('report',who,false);}
  await download('left','owner',true);data.savePage(pages.left.id,{published:true});await download('left',null,true);
  tenants.setSpaceTenant(space.id,tenant.id);
  for(const who of ['owner','reader','outsider','excluded',null]){
    for(const key of Object.keys(bytes))await download(key,who,who==='owner'||(who==='reader'&&key!=='draft'));
  }
  tenants.removeMember(tenant.id,'reader');await download('left','reader',false);
  tenants.removeMember(tenant.id,'owner');await download('left','owner',false);await download('draft','owner',false);
  tenants.addMember(tenant.id,'owner');await download('draft','owner',true);
  // A receipt failure occurs after files have been written. Compare all application
  // tables except the session's expected last_seen activity, and exact on-disk bytes.
  const tableNames=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'users' ORDER BY name").all().map(r=>r.name);
  const snapshot=()=>JSON.stringify(tableNames.map(name=>[name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all().map(row=>JSON.stringify(row)).sort()]));
  const diskSnapshot=()=>JSON.stringify(fs.readdirSync(UPLOADS_DIR).sort().map(name=>[name,fs.readFileSync(path.join(UPLOADS_DIR,name)).toString('base64')]));
  const before=snapshot(),diskBefore=diskSnapshot();
  db.exec("CREATE TRIGGER fail_markdown_asset_receipt BEFORE INSERT ON import_reports BEGIN SELECT RAISE(ABORT,'synthetic Markdown receipt failure'); END");
  try{
    const failed=await upload('Rollback Markdown assets');assert.match(failed,/^\/import\?error=/);assert.match(decodeURIComponent(failed),/synthetic Markdown receipt failure/);
    assert.equal(snapshot(),before,'Failed import leaves no new content, upload rows, membership, search records, or success receipt');
    assert.equal(diskSnapshot(),diskBefore,'Failed import removes its files and preserves existing files byte-for-byte');checks++;
  }finally{db.exec('DROP TRIGGER fail_markdown_asset_receipt');}
  await download('draft','owner',true);
  console.log(`PASS compiled Markdown assets: ${checks} upload/reference/byte/access/revocation/tenant/rollback checks using isolated synthetic data.`);

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
