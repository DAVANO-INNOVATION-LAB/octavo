// CI browser QA against a version-matched standalone build and synthetic imports only.
// npm run build && node scripts/markdown-import-plan-ui-test.mjs
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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-markdown-import-plan-ui-'));
const output = path.resolve(process.env.OCTAVO_UI_ARTIFACT_DIR || path.join(root, 'artifacts/markdown-import-plan'));
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
  const archive=zip([
    {name:'index.md',data:Buffer.from('# Platform guide\n\n[Notes](README.md)')},
    {name:'README.md',data:Buffer.from('---\npublished: false\n---\n# Release notes\n\nDraft release details.')},
    {name:'cluster/index.md',data:Buffer.from('# Cluster guide\n\n[Runbook](README.md)')},
    {name:'cluster/README.md',data:Buffer.from('# Cluster runbook\n\nOperational details.')},
    {name:'orphan/worker.md',data:Buffer.from('# Worker instructions\n\nWorker body preserved.')},
  ]);
  const fixture=path.join(temporary,'structure.zip');fs.writeFileSync(fixture,archive);
  const replacement=path.join(temporary,'replacement.md');fs.writeFileSync(replacement,'# Replacement selection');
  const tableNames=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'users' ORDER BY name").all().map(r=>r.name);
  const snapshot=()=>JSON.stringify(tableNames.map(name=>[name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all().map(row=>JSON.stringify(row)).sort()]));
  const files=()=>fs.existsSync(UPLOADS_DIR)?fs.readdirSync(UPLOADS_DIR).sort():[];
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
  const settle=()=>evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))).then(async () => { if (document.activeViewTransition) await document.activeViewTransition.finished; await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)); return true; })');
  const screenshot=async(name,width)=>{
    await settle();
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
    await waitFor(`document.querySelector('input[type="file"][name="file"]') && [...document.querySelectorAll('button')].some(b=>b.textContent==='Preview import')`,'upload form');
    const before=snapshot(),filesBefore=files();
    const {root:documentNode}=await send('DOM.getDocument',{},sessionId);
    const {nodeId}=await send('DOM.querySelector',{nodeId:documentNode.nodeId,selector:'input[type="file"][name="file"]'},sessionId);assert.ok(nodeId);
    await send('DOM.setFileInputFiles',{nodeId,files:[fixture]},sessionId);
    await waitFor(`document.querySelector('input[type="file"]').files.length===1`,'actual fixture selection');
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Preview import').click()`);
    await waitFor(`document.body?.innerText.includes('Nothing has been imported yet') && [...document.querySelectorAll('button')].some(b=>['Confirm and import','Confirm and import another copy'].includes(b.textContent))`,'preview plan');
    const oldDigest=await evaluate(`document.querySelector('input[name="previewDigest"]').value`);
    assert.equal(oldDigest,require('node:crypto').createHash('sha256').update(archive).digest('hex'));
    await send('DOM.setFileInputFiles',{nodeId,files:[replacement]},sessionId);
    await waitFor(`!document.querySelector('input[name="previewDigest"]') && !document.querySelector('[data-testid="import-page-plan-row"]') && [...document.querySelectorAll('button')].some(b=>b.textContent==='Preview import')`,'file reselection clears prior plan and digest');
    assert.equal(snapshot(),before);assert.deepEqual(files(),filesBefore);
    await send('DOM.setFileInputFiles',{nodeId,files:[fixture]},sessionId);
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Preview import').click()`);
    await waitFor(`document.querySelectorAll('[data-testid="import-page-plan-row"]').length===6`,'detailed structure preview');
    assert.equal(await evaluate(`document.querySelector('input[name="previewDigest"]').value`),oldDigest);
    await evaluate(`[...document.querySelectorAll('summary')].find(s=>s.textContent.includes('Preview page list')).click()`);
    await waitFor(`document.querySelector('ol[aria-label="Planned imported pages"]').closest('details').open`,'open page plan');
    const rowTexts=await evaluate(`[...document.querySelectorAll('[data-testid="import-page-plan-row"]')].map(r=>r.innerText)`);
    const row=title=>{const found=rowTexts.find(text=>text.startsWith(title));assert.ok(found,title);return found;};
    assert.match(row('Platform guide'),/Published/);assert.match(row('Platform guide'),/Top-level page/);assert.match(row('Platform guide'),/Source: index.md/);
    assert.match(row('Release notes'),/Draft/);assert.match(row('Release notes'),/Parent: Platform guide/);assert.match(row('Release notes'),/Source: README.md/);
    assert.match(row('Cluster runbook'),/Parent: Cluster guide/);assert.match(row('Cluster runbook'),/cluster\/README.md/);
    assert.match(row('orphan'),/Generated folder/);assert.match(row('orphan'),/Draft/);assert.match(row('orphan'),/no source document/);
    assert.match(row('Worker instructions'),/Parent: orphan/);assert.match(row('Worker instructions'),/orphan\/worker.md/);
    assert.equal(snapshot(),before,'Actual detailed browser preview is read-only');assert.deepEqual(files(),filesBefore);
    await screenshot(`preview-${label}`,width);
    await evaluate(`[...document.querySelectorAll('button')].find(b=>['Confirm and import','Confirm and import another copy'].includes(b.textContent)).click()`);
    await waitFor(`location.pathname!=='/import' && document.readyState==='complete'`,'confirmed import');
    const pathname=await evaluate('location.pathname');assert.match(pathname,/^\/[^/]+$/);
    const space=db.prepare('SELECT * FROM spaces WHERE slug=?').get(pathname.slice(1));assert.ok(space);
    const response=await fetch(`${base}/api/spaces/${space.slug}/import-report`,{headers:{cookie:'octavo_session=synthetic-ui-session'},signal:AbortSignal.timeout(5000)});
    assert.equal(response.status,200);const report=await response.json();
    assert.equal(report.preview.pages,6);assert.equal(report.counts.pages,6);assert.equal(report.counts.drafts,2);assert.equal(report.counts.attachmentsSaved,0);
    const actual=db.prepare('SELECT * FROM pages WHERE space_id=?').all(space.id);assert.equal(actual.length,6);
    const byTitle=new Map(actual.map(p=>[p.title,p]));assert.equal(byTitle.get('Release notes').parent_id,byTitle.get('Platform guide').id);assert.equal(byTitle.get('Cluster runbook').parent_id,byTitle.get('Cluster guide').id);assert.equal(byTitle.get('Worker instructions').parent_id,byTitle.get('orphan').id);
    await visit(`/${space.slug}/settings/import-report`);await waitFor(`document.body.innerText.includes('What was saved')`,'receipt');
    await screenshot(`receipt-${label}`,width);
    await settle();
    results.push({viewport:label,plannedPages:6,savedPages:report.counts.pages,reselectionClearsPlan:true});
    console.log(`PASS ${label}: actual ZIP selection, read-only preview plan, confirmation, exact receipt and bytes, screenshots`);
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
console.log(`PASS Markdown import plan UI; artifacts: ${output}`);

