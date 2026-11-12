// CI browser QA against a version-matched standalone build and synthetic imports only.
// npm run build && node scripts/import-plan-ui-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import Module, { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const httpOnly=process.argv.includes('--http-only');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-package-integrity-ui-'));
const output = path.resolve(process.env.OCTAVO_UI_ARTIFACT_DIR || path.join(root, 'artifacts/package-integrity'));
const oldDataDir = process.env.OCTAVO_DATA_DIR;
process.env.OCTAVO_DATA_DIR = path.join(temporary, 'data');
const originalLoad = Module._load, originalTs = Module._extensions['.ts'];
let db, server, chrome, ws, summary;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounded = (promise, ms, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]).finally(() => clearTimeout(timer));
};
const exited = child => !child || child.exitCode !== null || child.signalCode !== null;
async function stop(child) {
  if (!child?.pid) return;
  // Chrome launchers can exit before their descendants. Each fixture child owns
  // a dedicated process group, so cleanup never targets unrelated processes.
  const signal = value => {
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, value); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const done = exited(child) ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve));
  signal('SIGTERM');
  try { await bounded(done, 3000, 'process shutdown'); }
  catch { signal('SIGKILL'); await bounded(done, 3000, 'forced shutdown'); }
  // Reap remaining browser workers before removing their writable profile.
  signal('SIGKILL');
  await sleep(200);
}
function browserBinary() {
  const candidates = process.env.OCTAVO_BROWSER_BIN ? [process.env.OCTAVO_BROWSER_BIN] : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  for (const candidate of candidates) for (const directory of candidate.includes('/') ? [''] : (process.env.PATH || '').split(path.delimiter)) {
    const file = directory ? path.join(directory, candidate) : candidate;
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch { /* try next installed binary */ }
  }
  throw new Error('Install Chrome/Chromium or set OCTAVO_BROWSER_BIN to an executable');
}
Module._load = function(name, parent, main) {
  if (name === 'server-only') return {};
  if (name === 'next/headers') return { cookies: async () => ({ get: () => undefined }) };
  return originalLoad.call(this, name, parent, main);
};
Module._extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, file);
try {
  const binary = httpOnly ? null : browserBinary(), standalone = path.join(root, '.next/standalone');
  assert.ok(fs.existsSync(path.join(root, '.next/BUILD_ID')), 'Run npm run build first');
  // Next standalone excludes these assets. Match Docker's package layout, not an unstyled render.
  fs.cpSync(path.join(root, 'public'), path.join(standalone, 'public'), { recursive: true });
  fs.cpSync(path.join(root, '.next/static'), path.join(standalone, '.next/static'), { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  for (const file of ['result.json', 'verified-desktop.png', 'verified-mobile.png', 'legacy-desktop.png', 'legacy-mobile.png', 'invalid-desktop.png', 'invalid-mobile.png']) fs.rmSync(path.join(output, file), {force:true});
  db = require('../src/lib/db.ts').getDb();
  db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)')
    .run('ui-owner', 'owner@example.test', 'Synthetic Owner', '!', 'member', Date.now());
  db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run('synthetic-ui-session', 'ui-owner', Date.now() + 3600000);
  const socket = net.createServer();
  await bounded(new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); }), 5000, 'port allocation');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const spawnLogged = (binary, args, options, name) => {
    const fd = fs.openSync(path.join(output, name), 'w');
    const child = spawn(binary, args, { ...options, detached: process.platform !== 'win32', stdio: ['ignore', fd, fd] }); fs.closeSync(fd);
    child.on('error', error => { child.launchError = error; });
    return child;
  };
  server = spawnLogged(process.execPath, [path.join(standalone, 'server.js')], {
    cwd: standalone, env: { ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1', OCTAVO_COLLAB: '0' },
  }, 'server.log');
  let healthy = false;
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  for (const deadline = Date.now() + 30000; Date.now() < deadline;) {
    if (server.launchError) throw server.launchError;
    if (exited(server)) throw new Error('Standalone exited before health; see server.log');
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) { assert.equal((await response.json()).version, expected, 'Build must match checkout'); healthy = true; break; }
    } catch (error) { if (error.code === 'ERR_ASSERTION') throw error; }
    await sleep(100);
  }
  assert.ok(healthy, 'Standalone health timed out');
  const {zip,unzip}=require('../src/lib/zip.ts');
  const {UPLOADS_DIR}=require('../src/lib/db.ts');
  const data=require('../src/lib/data.ts'),roles=require('../src/lib/roles.ts');
  for(const name of ['reader','outsider']){
    db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(name,`${name}@example.test`,name,'!','member',Date.now());
    db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run(`synthetic-${name}`,name,Date.now()+3600000);
  }
  const space=data.createSpace({name:'Checksum source',visibility:'private'});roles.setSpaceMember(space.id,'ui-owner','admin');roles.setSpaceMember(space.id,'reader','reader');
  data.createPage({spaceId:space.id,title:'Published synthetic page',published:true,content:JSON.stringify([{type:'paragraph',content:[{type:'text',text:'Synthetic package content',styles:{}}],children:[]}])});
  data.createPage({spaceId:space.id,title:'Private draft sentinel',published:false});
  const cookie=who=>who==='owner'?'octavo_session=synthetic-ui-session':`octavo_session=synthetic-${who}`;
  const request=(url,who,options={})=>fetch(base+url,{redirect:'manual',signal:AbortSignal.timeout(15000),...options,headers:{...(who?{cookie:cookie(who)}:{}),...options.headers}});
  const exported=await request(`/api/spaces/${space.slug}/export`,'owner');assert.equal(exported.status,200);const archive=Buffer.from(await exported.arrayBuffer());
  const entries=unzip(archive),inventoryName=entries.find(e=>e.name.endsWith('/octavo-integrity.json'))?.name;assert.ok(inventoryName,'Real export includes checksum inventory');
  const inventory=JSON.parse(entries.find(e=>e.name===inventoryName).data.toString('utf8'));assert.equal(inventory.schemaVersion,1);assert.equal(inventory.algorithm,'sha256');assert.equal(inventory.files.length,entries.length-1);
  const fixture=path.join(temporary,'checksummed.zip');fs.writeFileSync(fixture,archive);
  const legacy=zip(entries.filter(e=>e.name!==inventoryName));const legacyFixture=path.join(temporary,'legacy.zip');fs.writeFileSync(legacyFixture,legacy);
  const markdownName=entries.find(e=>e.name.endsWith('.md')).name;
  const tampered=zip(entries.map(e=>e.name===markdownName?{...e,data:Buffer.from('Tampered payload with valid ZIP CRC')}:e));
  const invalidFixture=path.join(temporary,'tampered.zip');fs.writeFileSync(invalidFixture,tampered);
  const tableNames=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'users' ORDER BY name").all().map(r=>r.name);
  const snapshot=()=>JSON.stringify(tableNames.map(name=>[name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all().map(row=>JSON.stringify(row)).sort()]));
  const files=()=>fs.existsSync(UPLOADS_DIR)?fs.readdirSync(UPLOADS_DIR).sort():[];
  const formFor=(bytes,name='package.zip')=>{const form=new FormData();form.set('file',new Blob([bytes]),name);return form;};
  const preview=async bytes=>{const response=await request('/api/import/preview','owner',{method:'POST',body:formFor(bytes)});assert.equal(response.status,200);return response.json();};
  const verified=await preview(archive);assert.equal(verified.packageIntegrity.status,'verified');assert.equal(verified.packageIntegrity.files,inventory.files.length);
  const unverified=await preview(legacy);assert.equal(unverified.packageIntegrity.status,'unverified','Removing inventory is accepted only as unverified legacy');
  const variants=[['tampered',tampered],['missing',zip(entries.filter(e=>e.name!==markdownName))],['extra',zip([...entries,{name:'extra.txt',data:Buffer.from('extra')}])],['format-bypass',zip([...entries.map(e=>e.name===markdownName?{...e,data:Buffer.from('altered')}:e),{name:'entities.xml',data:Buffer.from('<hibernate-generic/>')},{name:'exportDescriptor.properties',data:Buffer.from('exportType=space')}])]];
  for(const [label,bytes]of variants){
    const before=snapshot(),beforeFiles=files();
    const invalid=await request('/api/import/preview','owner',{method:'POST',body:formFor(bytes)});assert.equal(invalid.status,400,label+' preview rejected');
    const attempted=await request('/api/import','owner',{method:'POST',body:formFor(bytes)});assert.equal(attempted.status,303);assert.match(attempted.headers.get('location'),/^\/import\?error=/,label+' import rejected');
    assert.equal(snapshot(),before,label+' leaves database unchanged');assert.deepEqual(files(),beforeFiles,label+' leaves files unchanged');
  }
  for(const who of [null,'outsider']){const denied=await request(`/api/spaces/${space.slug}/export`,who);assert.ok([401,403,404].includes(denied.status),'Private export protected');}
  const readerExport=await request(`/api/spaces/${space.slug}/export`,'reader');assert.equal(readerExport.status,200);const readerArchive=Buffer.from(await readerExport.arrayBuffer());const readerEntries=unzip(readerArchive);const readerManifest=JSON.parse(readerEntries.find(e=>e.name.endsWith('/octavo.json')).data.toString());assert.equal(readerManifest.pages.length,1);assert.ok(!readerManifest.pages.some(p=>p.title==='Private draft sentinel'));assert.equal((await preview(readerArchive)).packageIntegrity.status,'verified');
  for(const bytes of [archive,legacy]){const imported=await request('/api/import','owner',{method:'POST',body:formFor(bytes)});assert.equal(imported.status,303);assert.ok(!imported.headers.get('location').includes('error'));}
  console.log('PASS compiled export inventory, verified/legacy preview/import, tamper/missing/extra/format bypass rejection with zero writes and reader/outsider boundaries');
  if(httpOnly){summary={ok:true,version:expected,httpOnly:true,fixture:'synthetic only'};}else{
  chrome = spawnLogged(binary, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${temporary}/chrome`, 'about:blank'], {}, 'browser.log');
  let debug;
  for (const deadline = Date.now() + 20000; Date.now() < deadline;) {
    if (chrome.launchError) throw chrome.launchError;
    if (exited(chrome)) throw new Error('Browser exited before CDP; see browser.log');
    try {
      const debugPort = Number(fs.readFileSync(path.join(temporary, 'chrome/DevToolsActivePort'), 'utf8').split('\n')[0]);
      assert.ok(debugPort > 0 && debugPort < 65536);
      debug = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1500) })).json();
      if (debug.webSocketDebuggerUrl) break;
    } catch { /* startup pending */ }
    await sleep(100);
  }
  assert.ok(debug?.webSocketDebuggerUrl, 'Browser CDP startup timed out');
  assert.equal(new URL(debug.webSocketDebuggerUrl).hostname, '127.0.0.1');
  ws = new WebSocket(debug.webSocketDebuggerUrl);
  await bounded(new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }), 5000, 'CDP connection');
  let sequence = 0;
  const pending = new Map(), errors = [], downloads = new Map();
  let canceledInterceptions = 0;
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) { const item = pending.get(message.id); if (item) { pending.delete(message.id); if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result); } }
    if (message.method === 'Fetch.requestPaused') {
      const url = message.params.request.url;
      const allowed = url.startsWith(base + '/') || url.startsWith('data:') || url === 'about:blank';
      void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: message.params.requestId, ...(allowed ? {} : { errorReason: 'BlockedByClient' }) }, message.sessionId).catch(error => {
        // Navigation can cancel a paused request before CDP continues it.
        // This protocol race is not a page exception or an allowed network request.
        if (error.message === '{"code":-32602,"message":"Invalid InterceptionId."}') canceledInterceptions++;
        else errors.push(error.message);
      });
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map(arg => arg.value || arg.description).join(' '));
    if (message.method === 'Browser.downloadWillBegin') downloads.set(message.params.guid, { ...message.params, state: 'started' });
    if (message.method === 'Browser.downloadProgress') downloads.set(message.params.guid, { ...downloads.get(message.params.guid), ...message.params });
  };
  const send = (method, params = {}, sessionId) => {
    const id = ++sequence;
    return bounded(new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, sessionId })); }), 10000, method).finally(() => pending.delete(id));
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const domain of ['Page', 'Runtime', 'Network']) await send(`${domain}.enable`, {}, sessionId);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId);
  await send('Network.setCookie', { name: 'octavo_session', value: 'synthetic-ui-session', url: base }, sessionId);
  fs.mkdirSync(path.join(temporary, 'downloads'));
  await send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: path.join(temporary, 'downloads'), eventsEnabled: true });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression, label) => {
    for (const deadline = Date.now() + 12000; Date.now() < deadline;) { if (await evaluate(`Boolean(${expression})`)) return; await sleep(100); }
    throw new Error(`${label} timed out`);
  };
  const visit = async pathname => {
    const result = await send('Page.navigate', { url: base + pathname }, sessionId);
    assert.ok(!result.errorText, result.errorText);
    await waitFor(`location.pathname === ${JSON.stringify(pathname)} && document.readyState === 'complete'`, 'navigation');
  };
  const screenshot=async(name,width)=>{
    await evaluate('document.fonts.ready.then(() => true)');
    const info=await evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth,styles:[...document.styleSheets].filter(s=>s.href).length})');
    assert.equal(info.width,width);assert.ok(info.styles>0,'Packaged styles load');assert.ok(info.scroll<=width+1,'No horizontal overflow');
    const layout=await send('Page.getLayoutMetrics',{},sessionId);
    const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width,height:Math.ceil(layout.cssContentSize.height),scale:1}},sessionId);
    const png=Buffer.from(shot.data,'base64');assert.ok(png.length>1000);assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(png.readUInt32BE(16),width);
    fs.writeFileSync(path.join(output,name+'.png'),png);
  };
  const results=[];
  for(const [label,width,height]of[['desktop',1440,1100],['mobile',390,844]]){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:label==='mobile'},sessionId);
    const selectPreview=async file=>{
      await visit('/import');await waitFor(`document.querySelector('input[type="file"]')`,'file input');
      const documentNode=await send('DOM.getDocument',{},sessionId);const input=await send('DOM.querySelector',{nodeId:documentNode.root.nodeId,selector:'input[type="file"]'},sessionId);
      await send('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[file]},sessionId);
      await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Preview import').click()`);
    };
    await selectPreview(fixture);await waitFor(`document.querySelector('[data-testid="package-integrity-status"]')?.textContent==='Checksum inventory verified'`,'verified status');
    assert.ok(await evaluate(`document.querySelector('[data-testid="package-integrity"]').textContent.includes('inventory is unsigned')`));
    await screenshot(`verified-${label}`,width);
    await selectPreview(legacyFixture);await waitFor(`document.querySelector('[data-testid="package-integrity-status"]')?.textContent==='No verified checksum inventory'`,'legacy unverified status');
    assert.ok(await evaluate(`[...document.querySelectorAll('button')].some(b=>b.textContent.startsWith('Confirm and import'))`));
    await screenshot(`legacy-${label}`,width);
    const before=snapshot();await selectPreview(invalidFixture);await waitFor(`document.querySelector('[role="alert"]')`,'tampered package feedback');
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="package-integrity-status"]'))`),false,'No stale verified badge on failure');
    assert.equal(await evaluate(`[...document.querySelectorAll('button')].some(b=>b.textContent.startsWith('Confirm and import'))`),false,'Invalid preview cannot confirm');
    assert.equal(snapshot(),before);
    await screenshot(`invalid-${label}`,width);
    results.push({viewport:label,verified:true,legacyUnverified:true,invalidBlocked:true});
    console.log(`PASS ${label}: verified, legacy unverified, invalid feedback and no stale verified state`);
  }
  assert.deepEqual(errors,[],'Browser console/runtime errors');
  summary={ok:true,version:expected,screenshots:6,viewports:[1440,390],results,consoleErrors:errors,canceledInterceptions,fixture:'synthetic only'};

  }
}catch(error){summary={ok:false,failure:error.stack||String(error),fixture:"synthetic only"};throw error;} finally {
  const cleanupErrors = [];
  try { ws?.close(); } catch (error) { cleanupErrors.push(error); }
  const stopped = await Promise.allSettled([stop(chrome), stop(server)]);
  for (const result of stopped) if (result.status === 'rejected') cleanupErrors.push(result.reason);
  try { db?.close(); } catch (error) { cleanupErrors.push(error); }
  Module._load = originalLoad;
  if (originalTs) Module._extensions['.ts'] = originalTs; else delete Module._extensions['.ts'];
  if (oldDataDir === undefined) delete process.env.OCTAVO_DATA_DIR; else process.env.OCTAVO_DATA_DIR = oldDataDir;
  try { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (error) { cleanupErrors.push(error); }
  fs.mkdirSync(output,{recursive:true});if(cleanupErrors.length)summary={...summary,ok:false,cleanupErrors:cleanupErrors.map(String)};fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(summary,null,2));
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Synthetic UI fixture cleanup failed');
}
fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(summary, null, 2));
console.log(`PASS package integrity; artifacts: ${output}`);
