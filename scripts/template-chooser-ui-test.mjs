// CI browser QA against a version-matched standalone build and synthetic imports only.
// npm run build && node scripts/template-chooser-ui-test.mjs
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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-template-chooser-ui-'));
const output = path.resolve(process.env.OCTAVO_UI_ARTIFACT_DIR || path.join(root, 'artifacts/template-chooser'));
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
  for (const file of ['result.json', 'selected-desktop.png', 'selected-mobile.png', 'filtered-desktop.png', 'filtered-mobile.png']) fs.rmSync(path.join(output, file), {force:true});
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
  const {TEMPLATES}=require('../src/lib/templates.ts');
  const {buildTemplateCatalog}=require('../src/lib/template-catalog.ts');const catalog=buildTemplateCatalog(TEMPLATES);
  const defaultId=TEMPLATES.find(t=>t.group==='simple').id;
  const target=catalog.find(t=>t.group==='engineering'&&t.outline.some(p=>p.depth>0));assert.ok(target);
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='users' ORDER BY name").all().map(r=>r.name);
  const snapshot=()=>JSON.stringify(tables.map(name=>[name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all().map(row=>JSON.stringify(row)).sort()]));
  const typeInto=async(selector,text)=>{await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus();document.querySelector(${JSON.stringify(selector)}).select()`);await send('Input.insertText',{text},sessionId);};
  const selection=()=>evaluate(`new FormData(document.querySelector('input[name="name"]').form).getAll('template')`);
  const results=[];
  for(const [label,width,height] of [['desktop',1440,1100],['mobile',390,844]]){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:label==='mobile'},sessionId);
    await visit('/new');await waitFor(`document.getElementById('template-chooser-heading')`,'chooser');await settle();
    const before=snapshot();assert.deepEqual(await selection(),[defaultId]);
    await evaluate(`document.querySelector('#template-chooser-heading').closest('section').querySelector('select').value='engineering';document.querySelector('#template-chooser-heading').closest('section').querySelector('select').dispatchEvent(new Event('change',{bubbles:true}))`);
    await waitFor(`document.querySelector('input[name="template"][value="blank"]').closest('label').hidden`,'category filter');
    assert.deepEqual(await selection(),[defaultId],'Hidden default remains selected');
    const engineering=catalog.filter(t=>t.group==='engineering');assert.ok(engineering.length>1);
    await evaluate(`document.querySelector('input[name="template"][value=${JSON.stringify(engineering[0].id)}]').click();document.querySelector('input[name="template"]:checked').focus()`);
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40},sessionId);
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40},sessionId);
    await waitFor(`document.querySelector('input[name="template"]:checked').value===${JSON.stringify(engineering[1].id)}`,'native visible-radio keyboard navigation');
    assert.ok(await evaluate(`document.activeElement.matches('input[name="template"]') && !document.activeElement.closest('label').hidden`));
    await evaluate(`document.querySelector('input[name="template"][value=${JSON.stringify(target.id)}]').click()`);
    await waitFor(`document.getElementById('selected-template-heading').textContent===${JSON.stringify(target.name)}`,'selected outline');
    const outline=await evaluate(`[...document.querySelectorAll('ol[aria-label="Selected template page outline"] li')].map(li=>li.querySelector('span').textContent)`);
    assert.deepEqual(outline,target.outline.map(p=>p.title));assert.deepEqual(await selection(),[target.id]);
    const selectedText=await evaluate(`document.getElementById('selected-template-heading').closest('section').innerText`);assert.ok(selectedText.includes(`${target.pageCount} draft pages`));assert.ok(selectedText.includes('Parent:'));assert.ok(selectedText.includes('not published pages'));
    await screenshot(`selected-${label}`,width);
    // Search matches titles within the recursive page outline, not only card names.
    const nestedTitle=target.outline.find(p=>p.depth>0).title;
    await typeInto('input[type="search"]',nestedTitle);
    await waitFor(`!document.querySelector('input[name="template"][value=${JSON.stringify(target.id)}]').closest('label').hidden`,'outline-title search');
    await typeInto('input[type="search"]','zz-no-template-9384');
    await waitFor(`document.body.innerText.includes('No templates match these filters')`,'no results');
    assert.deepEqual(await selection(),[target.id]);assert.ok(await evaluate(`document.body.innerText.includes('Your selected template is hidden by the current filters')`));
    // Enter in search must not submit the surrounding create form.
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},sessionId);await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},sessionId);
    assert.equal(await evaluate('location.pathname'),'/new');
    await screenshot(`filtered-${label}`,width);
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Clear filters').click()`);
    await waitFor(`document.querySelector('input[type="search"]').value==='' && document.querySelector('#template-options label[hidden]')===null`,'clear search and category');
    assert.deepEqual(await selection(),[target.id],'Clearing filters does not reset selection');
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Use default template').click()`);
    await waitFor(`document.querySelector('input[name="template"]:checked').value===${JSON.stringify(defaultId)}`,'explicit default reset');assert.deepEqual(await selection(),[defaultId]);
    assert.equal(snapshot(),before,'Browsing, filtering, keyboard navigation and default reset write no application data');
    // Submit only this temporary synthetic fixture, proving the existing action
    // receives the exact catalog ID and still creates private draft content.
    await evaluate(`document.querySelector('input[name="template"][value=${JSON.stringify(target.id)}]').click()`);
    await typeInto('input[name="name"]',`Synthetic chooser ${label}`);
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Create and start writing').click()`);
    await waitFor(`location.pathname!=='/new' && document.readyState==='complete'`,'synthetic create action');
    const space=db.prepare('SELECT * FROM spaces WHERE name=?').get(`Synthetic chooser ${label}`);assert.ok(space);assert.equal(space.visibility,'private');
    const pages=db.prepare('SELECT * FROM pages WHERE space_id=?').all(space.id);assert.equal(pages.length,target.pageCount);assert.ok(pages.every(p=>p.published===0));assert.deepEqual(pages.map(p=>p.title).sort(),target.outline.map(p=>p.title).sort());
    assert.equal(db.prepare('SELECT role FROM space_members WHERE space_id=? AND user_id=?').get(space.id,'ui-owner').role,'admin');
    await settle();results.push({viewport:label,template:target.id,pages:pages.length,hiddenSelectionPreserved:true,nativeKeyboard:true,syntheticCreate:true});
    console.log(`PASS ${label}: search/category/native keyboard/hidden selection/reset/outline/screenshots/private draft creation`);
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
console.log(`PASS template chooser UI; artifacts: ${output}`);

