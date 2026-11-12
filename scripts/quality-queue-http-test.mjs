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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-quality-queue-http-'));
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
  const roles=require('../src/lib/roles.ts');
  for (const name of ['owner', 'reader', 'outsider', 'agent', 'excluded', 'admin']) {
    db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(name, `${name}@example.test`, name, '!', name === 'agent' ? 'agent' : name === 'admin' ? 'admin' : 'member', Date.now());
    db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run(`synthetic-${name}`, name, Date.now() + 86400000);
  }
  const space=data.createSpace({name:'Quality team',visibility:'private'});roles.setSpaceMember(space.id,'owner','editor');roles.setSpaceMember(space.id,'reader','reader');
  const fixture=[];for(let i=0;i<35;i++){const page=data.createPage({spaceId:space.id,title:'Target '+String(i).padStart(2,'0'),content:JSON.stringify([{type:'paragraph',content:[{type:'text',text:'BODY_EXCLUDED_FROM_EXPORT',styles:{}}],children:[]}])});db.prepare('INSERT INTO document_reviews(page_id,owner_id,due_at) VALUES(?,?,?)').run(page.id,'owner',Date.now()+86400000);fixture.push(page);}
  const outside=data.createPage({spaceId:space.id,title:'Different document'});
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
  const fetchHtml=async url=>{const response=await request(url,'owner');assert.equal(response.status,200,lastRequest);checks++;return (await response.text()).replace(/<!--[\s\S]*?-->/g,'');};
  const query=new URLSearchParams({search:'Target',state:'unreviewed',owner:'me',page:outside.id});
  const html=await fetchHtml('/quality?'+query);
  assert.match(html,/35 matched of 36 editable documents/);checks++;
  const selected=html.match(/<header data-testid="quality-selected-page">([\s\S]*?)<\/header>/)?.[1];assert.ok(selected?.includes('Target 00'));assert.ok(!selected.includes('Different document'));checks++;
  const queue=html.match(/<ul aria-label="Filtered review queue"[^>]*>([\s\S]*?)<\/ul>/)?.[1];assert.ok(queue);
  const decode=value=>value.replaceAll('&amp;','&');
  const links=[...queue.matchAll(/href="([^"]+)"/g)].map(m=>decode(m[1]));assert.equal(links.length,30);checks++;
  for(const href of links){const params=new URL(href,base).searchParams;assert.equal(params.get('search'),'Target');assert.equal(params.get('state'),'unreviewed');assert.equal(params.get('owner'),'me');assert.ok(fixture.some(page=>page.id===params.get('page')));checks++;}
  const pagination=html.match(/<nav aria-label="Review queue pages"[^>]*>([\s\S]*?)<\/nav>/)?.[1];assert.ok(pagination);const next=decode(pagination.match(/href="([^"]+)"/)?.[1]);assert.ok(next);const nextParams=new URL(next,base).searchParams;assert.equal(nextParams.get('queue'),'2');assert.equal(nextParams.get('search'),'Target');assert.equal(nextParams.get('owner'),'me');
  const nextHtml=await fetchHtml(next);assert.match(nextHtml,/>Target 30<\/h2>/);assert.equal((nextHtml.match(/<ul aria-label="Filtered review queue"[^>]*>([\s\S]*?)<\/ul>/)?.[1].match(/href="/g)??[]).length,5);checks++;
  const exportLinks=[...html.matchAll(/href="([^"]+)"[^>]*>Download filtered (CSV|JSON)<\/a>/g)].map(m=>({href:decode(m[1]),format:m[2].toLowerCase()}));assert.equal(exportLinks.length,2);
  for(const {href,format} of exportLinks){const params=new URL(href,base).searchParams;assert.equal(params.get('search'),'Target');assert.equal(params.get('owner'),'me');assert.equal(params.get('state'),'unreviewed');assert.equal(params.has('page'),false);assert.equal(params.has('queue'),false);const response=await request(href,'owner');assert.equal(response.status,200);assert.equal(response.headers.get('content-disposition'),`attachment; filename="octavo-quality-queue.${format}"`);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('x-octavo-matched-rows'),'35');const body=await response.text();assert.ok(!body.includes('BODY_EXCLUDED_FROM_EXPORT'));if(format==='json'){const report=JSON.parse(body);assert.deepEqual(report.rows.map(row=>row.pageId),fixture.map(page=>page.id));assert.deepEqual(report.counts,{editable:36,matched:35,exported:35});}else{assert.equal(body.trim().split('\r\n').length,36);assert.ok(body.includes('"Target 00"'));assert.ok(!body.includes('Different document'));}checks++;}
  const empty=await fetchHtml('/quality?search=NothingMatches&owner=me');assert.ok(empty.includes('No matching documents.'));assert.ok(!empty.includes('data-testid="quality-selected-page"'));checks++;
  const invalid=await fetchHtml('/quality?owner=unknown');assert.ok(invalid.includes('Downloads are unavailable until the filters are valid.'));assert.ok(!invalid.includes('Download filtered JSON'));assert.ok(!invalid.includes('data-testid="quality-selected-page"'));checks++;
  const allState=await request('/api/quality/queue?search=Target&owner=me&state=all&format=json','owner');assert.equal(allState.status,200);assert.deepEqual((await allState.json()).rows.map(row=>row.pageId),fixture.map(page=>page.id));checks++;
  for(const params of ['owner=unknown','state=unknown','format=pdf']){const response=await request('/api/quality/queue?'+params,'owner');assert.equal(response.status,400);await response.text();checks++;}
  for(const who of [null,'agent','reader']){const response=await request('/api/quality/queue?format=json',who);assert.equal(response.status,who==='reader'?200:404);const body=await response.text();if(who==='reader')assert.deepEqual(JSON.parse(body).rows,[]);checks++;}
  roles.removeSpaceMember(space.id,'owner');const removed=await request('/api/quality/queue?search=Target','owner');assert.equal(removed.status,200);assert.deepEqual((await removed.json()).rows,[]);checks++;
  console.log(`${checks} quality queue compiled HTTP checks passed (actual UI/filter/export routes and synthetic sessions)`);
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
