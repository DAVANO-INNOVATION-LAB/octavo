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
const httpOnly = process.argv.includes('--http-only');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-idempotency-ui-'));
const output = path.resolve(process.env.OCTAVO_UI_ARTIFACT_DIR || path.join(root, 'artifacts/import-idempotency'));
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
  for (const file of ['result.json', 'preview-desktop.png', 'preview-mobile.png', 'receipt-desktop.png', 'receipt-mobile.png']) fs.rmSync(path.join(output, file), {force:true});
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
  const {zip}=require('../src/lib/zip.ts');
  const {UPLOADS_DIR}=require('../src/lib/db.ts');
  const asset=Buffer.from([0,255,128,65,66,67,10,13,5,6,7]);
  const archive=zip([
    {name:'guide.md',data:Buffer.from('# Platform handbook\n\n![diagram](assets/chart.png)\n\n![diagram repeated](assets/chart.png#again)')},
    {name:'assets/chart.png',data:asset},
    {name:'assets/unused.png',data:Buffer.from('Unreferenced fixture')},
  ]);
  const fixture=path.join(temporary,'handbook.zip');fs.writeFileSync(fixture,archive);
  const tableNames=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'users' ORDER BY name").all().map(r=>r.name);
  const snapshot=()=>JSON.stringify(tableNames.map(name=>[name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all().map(row=>JSON.stringify(row)).sort()]));
  const files=()=>fs.existsSync(UPLOADS_DIR)?fs.readdirSync(UPLOADS_DIR).sort():[];
  if (httpOnly) {
    const submit = async () => {
      const form = new FormData(); form.set('file', new Blob([archive]), 'handbook.zip'); form.set('name', 'HTTP retry'); form.set('idempotencyKey', 'synthetic-http-retry-0001');
      return fetch(`${base}/api/import`, { method: 'POST', body: form, redirect: 'manual', headers: { cookie: 'octavo_session=synthetic-ui-session' }, signal: AbortSignal.timeout(15000) });
    };
    const first = await submit(); assert.equal(first.status, 303); const target = first.headers.get('location'); assert.ok(target && !target.includes('error'));
    const before = snapshot(); const filesBefore = files();
    const second = await submit(); assert.equal(second.headers.get('location'), target + '?importReplayed=1');
    assert.equal(snapshot(), before); assert.deepEqual(files(), filesBefore);
    summary = { ok: true, version: expected, httpOnly: true, fixture: 'synthetic only' };
    console.log('PASS compiled multipart replay leaves database and files unchanged');
  } else {
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
  for(const [label,width,height] of [['desktop',1440,1100],['mobile',390,844]]){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:label==='mobile'},sessionId);
    await visit('/import');
    if(label==='mobile')await evaluate(`Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true});true`);
    await waitFor(`document.querySelector('input[type="file"][name="file"]') && [...document.querySelectorAll('button')].some(b=>b.textContent==='Preview import')`,'upload form');
    const before=snapshot(),filesBefore=files();
    const {root:documentNode}=await send('DOM.getDocument',{},sessionId);
    const {nodeId}=await send('DOM.querySelector',{nodeId:documentNode.nodeId,selector:'input[type="file"][name="file"]'},sessionId);assert.ok(nodeId);
    await send('DOM.setFileInputFiles',{nodeId,files:[fixture]},sessionId);
    await waitFor(`document.querySelector('input[type="file"]').files.length===1`,'actual fixture selection');
    const initialKey=await evaluate(`document.querySelector('input[name="idempotencyKey"]').value`);assert.match(initialKey,/^[a-zA-Z0-9_-]{16,128}$/);if(label==='mobile')assert.match(initialKey,/^[a-f0-9]{32}$/,'WebCrypto fallback without randomUUID');
    // A name change rotates the key without replacing the selected file.
    await evaluate(`{ const input=document.querySelector('input[name="name"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Retry ${label}');input.dispatchEvent(new Event('input',{bubbles:true})); }`);
    await waitFor(`document.querySelector('input[name="idempotencyKey"]').value !== ${JSON.stringify(initialKey)}`,'name change rotates attempt');
    const nameKey=await evaluate(`document.querySelector('input[name="idempotencyKey"]').value`);
    await evaluate(`window.savedFetch=window.fetch;window.fetch=()=>Promise.resolve(new Response(JSON.stringify({error:'Synthetic preview failure'}),{status:503,headers:{'Content-Type':'application/json'}}));[...document.querySelectorAll('button')].find(b=>b.textContent==='Preview import').click()`);
    await waitFor(`document.querySelector('[role="alert"]')?.textContent.includes('Synthetic preview failure')`,'preview failure');
    assert.equal(await evaluate(`document.querySelector('input[name="idempotencyKey"]').value`),nameKey,'Preview failure preserves attempt key');
    await evaluate(`window.fetch=(...args)=>new Promise(resolve=>setTimeout(()=>resolve(window.savedFetch(...args)),400))`);
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Preview import').click()`);
    await waitFor(`[...document.querySelectorAll('button')].some(b=>b.textContent==='Checking import…')`,'preview busy state');
    assert.equal(await evaluate(`document.querySelector('input[name="idempotencyKey"]').value`),nameKey,'Busy preview preserves attempt key');

    await waitFor(`document.body?.innerText.includes('Nothing has been imported yet') && [...document.querySelectorAll('button')].some(b=>b.textContent==='Confirm and import')`,'preview plan');
    await evaluate('window.fetch=window.savedFetch;delete window.savedFetch');
    const previewText=await evaluate('document.body.innerText');
    const estimates=await evaluate(`Object.fromEntries([...document.querySelectorAll('#import-preview-heading ~ * dt, section[aria-labelledby="import-preview-heading"] dt')].map(dt=>[dt.textContent,dt.nextElementSibling.textContent]))`);
    assert.equal(estimates['Preview pages'],'1');assert.equal(estimates['Attachment-entry estimate'],'2');
    assert.ok(previewText.includes('Referenced asset copy plan'));
    assert.equal(await evaluate(`document.querySelector('[data-testid="import-asset-plan-files"]').textContent`),'1 referenced file planned for copying');
    assert.equal(await evaluate(`document.querySelector('[data-testid="import-asset-plan-bytes"]').textContent`),'11 bytes total planned');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('section[aria-labelledby="import-preview-heading"] dl')).display`),'grid','Tailwind preview layout applied');
    assert.equal(snapshot(),before,'Actual browser preview is read-only');assert.deepEqual(files(),filesBefore,'Preview writes no files');
    await screenshot(`preview-${label}`,width);
    const digest=await evaluate(`document.querySelector('input[name="previewDigest"]').value`);assert.match(digest,/^[a-f0-9]{64}$/);
    assert.equal(await evaluate(`document.querySelector('input[name="idempotencyKey"]').value`),nameKey,'Preview preserves attempt key');
    assert.ok(await evaluate(`document.querySelector('[data-testid="import-retry-guidance"]').textContent.includes('not duplicate-file detection')`));
    const serialized=await evaluate(`Promise.all([...new FormData(document.querySelector('form[action="/api/import"]')).entries()].map(async([key,value])=>typeof value==='string'?{key,value}:{key,name:value.name,bytes:[...new Uint8Array(await value.arrayBuffer())]}))`);
    const spacesBefore=db.prepare('SELECT COUNT(*) n FROM spaces').get().n;
    const reportsBefore=db.prepare('SELECT COUNT(*) n FROM import_reports').get().n;

    await evaluate(`{const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='Confirm and import');button.click();button.click();}`);
    await waitFor(`location.pathname!=='/import' && document.readyState==='complete'`,'confirmed import');
    const pathname=await evaluate('location.pathname');assert.match(pathname,/^\/[^/]+$/);
    const space=db.prepare('SELECT * FROM spaces WHERE slug=?').get(pathname.slice(1));assert.ok(space);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM spaces').get().n,spacesBefore+1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM import_reports').get().n,reportsBefore+1);
    const filesAfter=files();
    const replays=await evaluate(`Promise.all([0,1].map(async()=>{const form=new FormData();for(const entry of ${JSON.stringify(serialized)})form.append(entry.key,entry.bytes?new File([new Uint8Array(entry.bytes)],entry.name):entry.value);const response=await fetch('/api/import',{method:'POST',body:form});return response.url;}))`);
    for(const url of replays)assert.equal(new URL(url).pathname,pathname);
    for(const url of replays)assert.equal(new URL(url).searchParams.get('importReplayed'),'1');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM spaces').get().n,spacesBefore+1,'Repeated submissions do not duplicate space');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM import_reports').get().n,reportsBefore+1,'Repeated submissions do not duplicate receipt');
    assert.deepEqual(files(),filesAfter,'Repeated submissions do not duplicate uploads');
    const response=await fetch(`${base}/api/spaces/${space.slug}/import-report`,{headers:{cookie:'octavo_session=synthetic-ui-session'},signal:AbortSignal.timeout(5000)});
    assert.equal(response.status,200);const report=await response.json();
    assert.deepEqual(report.preview.assetPlan,{files:1,bytes:asset.length});assert.equal(report.preview.attachmentEntries,2);assert.equal(report.counts.attachmentsSaved,1);
    const uploads=db.prepare('SELECT * FROM uploads WHERE space_id=?').all(space.id);assert.equal(uploads.length,1);assert.deepEqual(fs.readFileSync(path.join(UPLOADS_DIR,uploads[0].name)),asset);
    await visit(`/${space.slug}/settings/import-report`);await waitFor(`document.body?.innerText.includes('What was saved')`,'receipt');
    await screenshot(`receipt-${label}`,width);
    await visit('/import');
    const freshDocument=await send('DOM.getDocument',{},sessionId);
    const freshInput=await send('DOM.querySelector',{nodeId:freshDocument.root.nodeId,selector:'input[type="file"][name="file"]'},sessionId);
    await send('DOM.setFileInputFiles',{nodeId:freshInput.nodeId,files:[fixture]},sessionId);
    const separateBefore=await evaluate(`document.querySelector('input[name="idempotencyKey"]').value`);
    await evaluate(`document.querySelector('[data-testid="separate-import"]').click()`);
    await waitFor(`document.querySelector('input[name="idempotencyKey"]').value !== ${JSON.stringify(separateBefore)}`,'separate attempt rotates key');
    const fileBefore=await evaluate(`document.querySelector('input[name="idempotencyKey"]').value`);
    const otherFixture=path.join(temporary,`other-${label}.md`);fs.writeFileSync(otherFixture,'# Different synthetic file');
    await send('DOM.setFileInputFiles',{nodeId:freshInput.nodeId,files:[otherFixture]},sessionId);
    await waitFor(`document.querySelector('input[name="idempotencyKey"]').value !== ${JSON.stringify(fileBefore)}`,'new file rotates key');
    results.push({viewport:label,preview:{files:1,bytes:asset.length},saved:report.counts.attachmentsSaved});
    console.log(`PASS ${label}: actual ZIP selection, read-only preview plan, confirmation, exact receipt and bytes, screenshots`);
  }
  assert.deepEqual(errors,[],'Browser console/runtime errors');
  summary={ok:true,version:expected,screenshots:4,viewports:[1440,390],results,consoleErrors:errors,canceledInterceptions,fixture:'synthetic only'};

  }
} catch (error) {
  summary = { ok: false, fixture: "synthetic only", failure: error.stack || String(error) };
  throw error;
} finally {
  const cleanupErrors = [];
  try { ws?.close(); } catch (error) { cleanupErrors.push(error); }
  const stopped = await Promise.allSettled([stop(chrome), stop(server)]);
  for (const result of stopped) if (result.status === 'rejected') cleanupErrors.push(result.reason);
  try { db?.close(); } catch (error) { cleanupErrors.push(error); }
  Module._load = originalLoad;
  if (originalTs) Module._extensions['.ts'] = originalTs; else delete Module._extensions['.ts'];
  if (oldDataDir === undefined) delete process.env.OCTAVO_DATA_DIR; else process.env.OCTAVO_DATA_DIR = oldDataDir;
  try { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (error) { cleanupErrors.push(error); }
  fs.mkdirSync(output,{recursive:true});
  if (cleanupErrors.length) summary={...summary,ok:false,cleanupErrors:cleanupErrors.map(String)};
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(summary,null,2));
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Synthetic UI fixture cleanup failed');
}
fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(summary, null, 2));
console.log(`PASS import idempotency ${httpOnly ? 'HTTP' : 'UI'}; artifacts: ${output}`);
