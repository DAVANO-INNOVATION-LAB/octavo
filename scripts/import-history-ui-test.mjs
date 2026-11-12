// CI browser QA against a version-matched standalone build and synthetic imports only.
// npm run build && node scripts/import-history-ui-test.mjs
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
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-history-ui-'));
const output = path.resolve(process.env.OCTAVO_UI_ARTIFACT_DIR || path.join(root, 'artifacts/import-history'));
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
  const binary = browserBinary(), standalone = path.join(root, '.next/standalone');
  assert.ok(fs.existsSync(path.join(root, '.next/BUILD_ID')), 'Run npm run build first');
  // Next standalone excludes these assets. Match Docker's package layout, not an unstyled render.
  fs.cpSync(path.join(root, 'public'), path.join(standalone, 'public'), { recursive: true });
  fs.cpSync(path.join(root, '.next/static'), path.join(standalone, '.next/static'), { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  for (const file of ['result.json', 'empty-desktop.png', 'empty-mobile.png', 'history-desktop.png', 'history-mobile.png']) fs.rmSync(path.join(output, file), {force:true});
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
  const viewports=[['desktop',1440,1100],['mobile',390,844]];
  for(const [label,width,height] of viewports){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:label==='mobile'},sessionId);
    await visit('/import/history');await waitFor(`document.body.innerText.includes('No import reports to show')`,'empty history');
    assert.equal(await evaluate(`document.querySelectorAll('article').length`),0);
    await screenshot(`empty-${label}`,width);
    await evaluate(`[...document.querySelectorAll('a')].find(a=>a.textContent.trim()==='Start an import').click()`);
    await waitFor(`location.pathname==='/import' && document.querySelector('input[type="file"]')`,'start import link');
    await evaluate(`document.querySelector('a[href="/import/history"]').click()`);
    await waitFor(`location.pathname==='/import/history' && document.body.innerText.includes('No import reports to show')`,'import recent history link');
  }
  const data=require('../src/lib/data.ts'),roles=require('../src/lib/roles.ts'),reports=require('../src/lib/import-reports.ts');
  const fixtures=[];
  for(let i=0;i<21;i++){
    const name=`Engineering handbook ${String(i).padStart(2,'0')}`;
    const space=data.createSpace({name,visibility:'private'});roles.setSpaceMember(space.id,'ui-owner','admin');
    const page=data.createPage({spaceId:space.id,title:'Handbook content'});data.savePage(page.id,{published:true});
    const report=db.transaction(()=>reports.createImportReport({spaceId:space.id,actorId:'ui-owner',sourceKind:'upload',sourceLabel:`handbook-${String(i).padStart(2,'0')}.md`,preview:{pages:1,attachmentEntries:0,warnings:i===20?['Review the synthetic external reference.']:[]}}))();
    report.completedAt=1700000000000+i*1000;
    db.prepare('UPDATE import_reports SET completed_at=?,report_json=? WHERE id=?').run(report.completedAt,JSON.stringify({...report,actorId:null}),report.id);
    fixtures.push({space,page,report});
  }
  // Historical count stays one after the current space gains an extra page.
  data.createPage({spaceId:fixtures[0].space.id,title:'Later addition'});
  const hidden=data.createSpace({name:'HIDDEN-unrelated-import',visibility:'public'});
  db.transaction(()=>reports.createImportReport({spaceId:hidden.id,actorId:'ui-owner',sourceKind:'upload',sourceLabel:'HIDDEN-file.md'}))();
  for(const [label,width,height] of viewports){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:label==='mobile'},sessionId);
    await visit('/import/history');
    await waitFor(`document.querySelectorAll('ol[aria-label="Import completion reports"] article').length===20`,'populated history');
    const cards=await evaluate(`[...document.querySelectorAll('article')].map(a=>({title:a.querySelector('h2').textContent,text:a.innerText,counts:Object.fromEntries([...a.querySelectorAll('dt')].map(dt=>[dt.textContent,dt.nextElementSibling.textContent]))}))`);
    assert.deepEqual(cards.map(c=>c.title),fixtures.slice(1).reverse().map(f=>f.space.name));
    assert.equal(cards[0].counts['Warnings recorded'],'1');assert.equal(cards[0].counts['Pages saved'],'1');assert.equal(cards[0].counts['Attachments saved'],'0');
    assert.ok(!await evaluate(`document.body.innerText.includes('HIDDEN-')`));
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('article dl')).display`),'grid','Tailwind count grid applied');
    await screenshot(`history-${label}`,width);
    await evaluate(`[...document.querySelectorAll('nav[aria-label="Import history pages"] a')].find(a=>a.textContent.trim()==='Older').click()`);
    await waitFor(`location.search==='?page=2' && document.querySelectorAll('article').length===1`,'older page');
    assert.equal(await evaluate(`document.querySelector('article h2').textContent`),fixtures[0].space.name);
    assert.equal(await evaluate(`document.querySelector('article dd').textContent`),'1','History count remains completion snapshot');
    assert.ok(!await evaluate(`[...document.querySelectorAll('nav[aria-label="Import history pages"] a')].some(a=>a.textContent.trim()==='Older')`));
    await evaluate(`[...document.querySelectorAll('nav[aria-label="Import history pages"] a')].find(a=>a.textContent.trim()==='Newer').click()`);
    await waitFor(`location.search==='' && document.querySelectorAll('article').length===20`,'newer page');
    const latest=fixtures[20].space;
    await evaluate(`document.querySelector('a[aria-label=${JSON.stringify('View report for '+latest.name)}]').click()`);
    await waitFor(`location.pathname===${JSON.stringify('/'+latest.slug+'/settings/import-report')} && document.body.innerText.includes('What was saved')`,'report card link');
    await visit('/import/history');
    await evaluate(`document.querySelector('a[aria-label=${JSON.stringify('Open space '+latest.name)}]').click()`);
    await waitFor(`location.pathname===${JSON.stringify('/'+latest.slug)} && document.readyState==='complete'`,'open space card link');
    results.push({viewport:label,cards:20,olderCards:1,links:['Older','Newer','View report','Open space','Start an import','Recent imports']});
    console.log(`PASS ${label}: empty/populated screenshots, ordered visible cards, current access, snapshot counts, pagination and links`);
  }
  assert.deepEqual(errors,[],'Browser console/runtime errors');
  summary={ok:true,version:expected,screenshots:4,viewports:[1440,390],results,consoleErrors:errors,canceledInterceptions,fixture:'synthetic only'};

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
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Synthetic UI fixture cleanup failed');
}
fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(summary, null, 2));
console.log(`PASS import history UI; artifacts: ${output}`);

