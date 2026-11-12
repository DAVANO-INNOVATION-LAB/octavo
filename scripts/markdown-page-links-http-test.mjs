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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-markdown-page-links-http-'));
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
  const fileBytes=Buffer.from([0,255,128,71,10,13]);
  const archive=zip([
    {name:'bundle/a-start.md',data:Buffer.from('# Navigation hub\n\n[First](b-first.md?view=compact#one)\n\n[Second](c-second.md)\n\n[Index](nested/readme.md)\n\n[Draft](draft.md)\n\n[Data](assets/data.bin)')},
    {name:'bundle/b-first.md',data:Buffer.from('# Shared title\n\nFIRST DESTINATION\n\n[Back](a-start.md)')},
    {name:'bundle/c-second.md',data:Buffer.from('# Shared title\n\nSECOND DESTINATION')},
    {name:'bundle/nested/readme.md',data:Buffer.from('# Container heading\n\nCONTAINER DESTINATION\n\n[Sibling](../c-second.md)')},
    {name:'bundle/draft.md',data:Buffer.from('---\npublished: false\n---\n# Draft heading\n\nDRAFT DESTINATION')},
    {name:'bundle/assets/data.bin',data:fileBytes},
  ]);
  const upload=async(bytes,name)=>{
    const form=new FormData();form.set('name',name);form.set('file',new Blob([bytes]),'links.zip');
    const response=await request('/api/import','owner',{method:'POST',body:form});assert.equal(response.status,303);checks++;
    return response.headers.get('location');
  };
  const location=await upload(archive,'HTTP page links');assert.ok(location&&!location.includes('error='),location);
  const space=data.getSpaceBySlug(location.slice(1));assert.ok(space);
  const pages=db.prepare('SELECT * FROM pages WHERE space_id=?').all(space.id);
  const byMarker=marker=>{const p=pages.find(p=>p.content.includes(marker));assert.ok(p,marker);return p;};
  const first=byMarker('FIRST DESTINATION'),second=byMarker('SECOND DESTINATION'),container=byMarker('CONTAINER DESTINATION'),draft=byMarker('DRAFT DESTINATION');
  const source=pages.find(p=>p.title==='Navigation hub');assert.ok(source);
  assert.notEqual(first.slug,second.slug);assert.equal(first.title,second.title);
  const hrefs=row=>{const found=[];const walk=node=>{if(Array.isArray(node))node.forEach(walk);else if(node&&typeof node==='object'){if(node.type==='link')found.push(node.href);Object.values(node).forEach(walk);}};walk(JSON.parse(row.content));return found;};
  const expected=p=>`/${space.slug}/${p.slug}`;
  assert.deepEqual(hrefs(source).filter(href=>!href.startsWith('/api/files/')),[expected(first)+'?view=compact#one',expected(second),expected(container),expected(draft)]);
  assert.deepEqual(hrefs(first),[expected(source)]);assert.deepEqual(hrefs(container),[expected(second)]);checks++;
  for(const [page,marker] of [[first,'FIRST DESTINATION'],[second,'SECOND DESTINATION'],[container,'CONTAINER DESTINATION'],[draft,'DRAFT DESTINATION']]){
    const response=await request(expected(page),'owner');assert.equal(response.status,200);assert.ok((await response.text()).includes(marker));checks++;
  }
  roles.setSpaceMember(space.id,'reader','reader');
  for(const who of ['reader','outsider',null])for(const page of [first,draft]){
    const response=await request(expected(page),who);assert.equal(response.status,who==='reader'?(page===first?200:404):307);if(who!=='reader')assert.equal(response.headers.get('location'),who?'/':'/login');const body=await response.text();if(!(who==='reader'&&page===first))assert.ok(!body.includes('DESTINATION'));checks++;
  }
  data.updateSpace(space.id,{visibility:'public'});
  for(const page of [first,draft]){const response=await request(expected(page),null);assert.equal(response.status,page===first?200:404);await response.arrayBuffer();checks++;}
  const file=hrefs(source).find(href=>href.startsWith('/api/files/'));assert.ok(file);
  const response=await request(file,'owner');assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),fileBytes);checks++;
  const reportResponse=await request(`/api/spaces/${space.slug}/import-report`,'owner');assert.equal(reportResponse.status,200);const report=await reportResponse.json();
  assert.equal(report.counts.attachmentsSaved,1);assert.ok(!report.warnings.some(w=>/relative link/i.test(w)),JSON.stringify(report.warnings));checks++;
  const missingLoc=await upload(zip([{name:'missing.md',data:Buffer.from('# Missing\n\n[Unresolved](absent.md)')}]),'Unresolved links');
  const missingSpace=data.getSpaceBySlug(missingLoc.slice(1));assert.ok(missingSpace);
  const missingPage=db.prepare('SELECT * FROM pages WHERE space_id=?').get(missingSpace.id);assert.deepEqual(hrefs(missingPage),['absent.md']);
  const missingReport=await request(`/api/spaces/${missingSpace.slug}/import-report`,'owner');assert.ok((await missingReport.json()).warnings.some(w=>/relative link/i.test(w)));checks++;
  const notionA='11111111111111111111111111111111',notionB='22222222222222222222222222222222';
  const notionLoc=await upload(zip([
    {name:`Start ${notionA}.md`,data:Buffer.from(`# Notion hub\n\n[Target](Destination%20${notionB}.md#details)`)},
    {name:`Destination ${notionB}.md`,data:Buffer.from('# Different actual heading\n\nNOTION DESTINATION')},
  ]),'Notion page links');
  const notionSpace=data.getSpaceBySlug(notionLoc.slice(1));assert.ok(notionSpace);
  const notionPages=db.prepare('SELECT * FROM pages WHERE space_id=?').all(notionSpace.id);
  const notionHub=notionPages.find(p=>p.title==='Notion hub'),notionDestination=notionPages.find(p=>p.title==='Different actual heading');assert.ok(notionHub&&notionDestination);
  assert.deepEqual(hrefs(notionHub),[`/${notionSpace.slug}/${notionDestination.slug}#details`]);
  const notionResponse=await request(hrefs(notionHub)[0],'owner');assert.equal(notionResponse.status,200);assert.ok((await notionResponse.text()).includes('NOTION DESTINATION'));checks++;
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='users' ORDER BY name").all().map(r=>r.name);
  const snapshot=()=>JSON.stringify(tables.map(name=>[name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all().map(row=>JSON.stringify(row)).sort()]));
  const disk=()=>JSON.stringify(fs.readdirSync(UPLOADS_DIR).sort().map(name=>[name,fs.readFileSync(path.join(UPLOADS_DIR,name)).toString('base64')]));
  const before=snapshot(),filesBefore=disk();
  db.exec("CREATE TRIGGER fail_page_link_receipt BEFORE INSERT ON import_reports BEGIN SELECT RAISE(ABORT,'synthetic page-link receipt failure'); END");
  try{const failed=await upload(archive,'Rollback page links');assert.match(failed,/^\/import\?error=/);assert.equal(snapshot(),before);assert.equal(disk(),filesBefore);checks++;}
  finally{db.exec('DROP TRIGGER fail_page_link_receipt');}
  console.log(`PASS compiled Markdown page links: ${checks} upload/real-slug/navigation/draft/Notion/asset/warnings/rollback checks using isolated synthetic data.`);

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
