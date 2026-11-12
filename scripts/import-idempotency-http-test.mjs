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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-import-idempotency-http-'));
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
  const count=()=>db.prepare('SELECT COUNT(*) n FROM import_reports').get().n;
  const upload=async(key,content='# Retry safe fixture',name='Retry fixture',who='owner',filename='fixture.md',target=base)=>{
    const form=new FormData();form.set('file',new Blob([content]),filename);form.set('name',name);if(key!==null)form.set('idempotencyKey',key);
    const response=await fetch(target+'/api/import',{method:'POST',body:form,redirect:'manual',signal:AbortSignal.timeout(20000),headers:{connection:'close',origin:target,cookie:`octavo_session=synthetic-${who}`}});
    assert.equal(response.status,303);checks++;return response.headers.get('location');
  };
  const key='retry-safe-00000000000000000001';
  const first=await upload(key);assert.ok(!first.includes('error='));const space=data.getSpaceBySlug(first.split('?')[0].slice(1));assert.ok(space);
  const before=count();const again=await upload(key);assert.equal(new URL(again,base).pathname,first.split('?')[0]);assert.equal(count(),before);checks+=2;
  assert.match(await upload(key,'# Changed content'),/error=/);assert.match(await upload(key,undefined,'Changed name'),/error=/);assert.match(await upload(key,undefined,undefined,'owner','other.md'),/error=/);assert.equal(count(),before);checks+=4;
  const other=await upload(key,undefined,undefined,'reader');assert.ok(!other.includes('error='));assert.notEqual(new URL(other,base).pathname,new URL(first,base).pathname);checks+=2;
  // A fresh server process must observe the committed key, not an in-memory cache.
  server.kill('SIGTERM');await once(server,'exit');
  const fd=fs.openSync(logPath,'a');server=spawn(process.execPath,[path.resolve('.next/standalone/server.js')],{cwd:process.cwd(),env:{...process.env,PORT:String(port),HOSTNAME:'127.0.0.1',OCTAVO_COLLAB:'0'},stdio:['ignore',fd,fd]});fs.closeSync(fd);
  for(let i=0;;i++){try{if((await fetch(base+'/api/health',{signal:AbortSignal.timeout(1000)})).ok)break;}catch{}if(i>100||server.exitCode!==null)throw new Error('Restart failed');await new Promise(r=>setTimeout(r,100));}
  assert.equal(new URL(await upload(key),base).pathname,new URL(first,base).pathname);checks++;
  // Same key raced through two independent application processes sharing SQLite.
  const secondSocket=net.createServer().listen(0,'127.0.0.1');await once(secondSocket,'listening');const port2=secondSocket.address().port;await new Promise(r=>secondSocket.close(r));
  const secondFd=fs.openSync(logPath,'a');const second=spawn(process.execPath,[path.resolve('.next/standalone/server.js')],{cwd:process.cwd(),env:{...process.env,PORT:String(port2),HOSTNAME:'127.0.0.1',OCTAVO_COLLAB:'0'},stdio:['ignore',secondFd,secondFd]});fs.closeSync(secondFd);
  const base2=`http://127.0.0.1:${port2}`;
  try{
    for(let i=0;;i++){try{if((await fetch(base2+'/api/health',{signal:AbortSignal.timeout(1000)})).ok)break;}catch{}if(i>100||second.exitCode!==null)throw new Error('Second server failed');await new Promise(r=>setTimeout(r,100));}
    const initial=count(),raceKey='retry-safe-00000000000000000002';
    const results=await Promise.all([upload(raceKey,'# Parallel','Parallel','owner','parallel.md'),upload(raceKey,'# Parallel','Parallel','owner','parallel.md',base2)]);
    assert.ok(results.every(r=>!r.includes('error=')));assert.equal(new URL(results[0],base).pathname,new URL(results[1],base).pathname);assert.equal(count(),initial+1);checks+=3;
  }finally{if(second.exitCode===null){second.kill('SIGTERM');await once(second,'exit');}}
  roles.removeSpaceMember(space.id,'owner');assert.match(await upload(key),/error=/);checks++;
  roles.setSpaceMember(space.id,'owner','admin');db.prepare('INSERT INTO deleted_spaces(space_id,deleted_at,deleted_by) VALUES(?,?,?)').run(space.id,Date.now(),'owner');assert.match(await upload(key),/error=/);checks++;
  const unkeyed=count();await upload(null,'# Independent','Independent');await upload(null,'# Independent','Independent');assert.equal(count(),unkeyed+2);checks++;
  console.log(`PASS compiled retry-safe imports: ${checks} checks including restart and two-process concurrency, synthetic only`);

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
