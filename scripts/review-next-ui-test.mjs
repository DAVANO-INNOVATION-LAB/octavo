// CI browser QA against a version-matched standalone build and synthetic imports only.
// npm run build && node scripts/review-next-ui-test.mjs
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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-review-next-ui-'));
const output = path.resolve(process.env.OCTAVO_UI_ARTIFACT_DIR || path.join(root, 'artifacts/review-next'));
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
  for (const file of ['result.json', ...['desktop','mobile'].flatMap(v=>['ready','next','complete'].map(p=>`${p}-${v}.png`))]) fs.rmSync(path.join(output, file), {force:true});
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
  const data=require('../src/lib/data.ts'),roles=require('../src/lib/roles.ts');
  const space=data.createSpace({name:'Review workflow fixtures',visibility:'private'});roles.setSpaceMember(space.id,'ui-owner','admin');
  const fixtures={};
  for(const label of ['desktop','mobile']){
    fixtures[label]=[];
    for(let i=0;i<3;i++){
      const content=JSON.stringify([{id:`block-${label}-${i}`,type:'paragraph',props:{},content:[{type:'text',text:`Synthetic ${label} body ${i}`,styles:{}}],children:[]}]);
      const page=data.createPage({spaceId:space.id,title:`${label} review ${i}`,content});fixtures[label].push(page);
      db.prepare('INSERT INTO document_reviews(page_id,owner_id,due_at) VALUES(?,?,?)').run(page.id,'ui-owner',Date.now()+30*86400000);
    }
  }
  const tableNames=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='users' ORDER BY name").all().map(r=>r.name);
  const snapshot=()=>JSON.stringify(tableNames.map(name=>[name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all().map(row=>JSON.stringify(row)).sort()]));
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
    const target=new URL(pathname,base);
    await waitFor(`location.pathname + location.search === ${JSON.stringify(target.pathname+target.search)} && document.readyState === 'complete'`, 'navigation');
  };
  const settle=()=>evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))).then(async () => { if (document.activeViewTransition) await document.activeViewTransition.finished; await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)); return true; })');
  const screenshot=async(name,width)=>{
    await settle();await evaluate('scrollTo(0,0)');
    await evaluate('document.fonts.ready.then(() => true)');
    const info=await evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth,styles:[...document.styleSheets].filter(s=>s.href).length})');
    assert.equal(info.width,width);assert.ok(info.styles>0,'Packaged styles load');assert.ok(info.scroll<=width+1,'No horizontal overflow');
    const layout=await send('Page.getLayoutMetrics',{},sessionId);
    const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width,height:Math.min(1400,Math.ceil(layout.cssContentSize.height)),scale:1}},sessionId);
    const png=Buffer.from(shot.data,'base64');assert.ok(png.length>1000);assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(png.readUInt32BE(16),width);
    fs.writeFileSync(path.join(output,name+'.png'),png);
  };
  const reviewRows=except=>JSON.stringify(db.prepare('SELECT * FROM document_reviews ORDER BY page_id').all().filter(r=>r.page_id!==except));
  const pageRows=()=>JSON.stringify(db.prepare('SELECT * FROM pages ORDER BY id').all());
  const verifyForm=`document.querySelector('input[name="operation"][value="verify"]').closest('form')`;
  const due=new Date(Date.now()+90*86400000).toISOString().slice(0,10);
  const submit=async advance=>{
    await evaluate(`${verifyForm}.querySelector('input[name="due"]').value=${JSON.stringify(due)}`);
    await evaluate(`${verifyForm}.querySelector(${JSON.stringify(advance?'button[name="advance"]':'button:not([name])')}).click()`);
  };
  const assertContext=async label=>{
    const current=await evaluate('Object.fromEntries(new URLSearchParams(location.search))');
    assert.equal(current.search,`${label} review`);assert.equal(current.state,'unreviewed');assert.equal(current.owner,'me');assert.equal(current.queue,'1');return current;
  };
  const results=[];
  for(const [label,width,height] of [['desktop',1440,1100],['mobile',390,844]]){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:label==='mobile'},sessionId);
    const [first,second,last]=fixtures[label];
    await visit('/quality?'+new URLSearchParams({search:`${label} review`,state:'unreviewed',owner:'me',queue:'1',page:first.id}));
    await waitFor(`document.querySelector('[data-testid="quality-selected-page"] h2')?.textContent===${JSON.stringify(first.title)}`,'selected synthetic review');
    const hidden=await evaluate(`Object.fromEntries([...${verifyForm}.querySelectorAll('input[type="hidden"]')].filter(i=>i.name.startsWith('queue')).map(i=>[i.name,i.value]))`);
    assert.deepEqual(hidden,{queueSearch:`${label} review`,queueState:'unreviewed',queueOwner:'me',queuePage:'1'});
    // Ordinary verification keeps queue context without asking to advance.
    let otherBefore=reviewRows(first.id),pagesBefore=pageRows();await submit(false);
    await waitFor(`new URLSearchParams(location.search).get('reviewed')==='1' && document.querySelector('[data-testid="quality-selected-page"] h2')?.textContent===${JSON.stringify(second.title)}`,'ordinary verify preserving filtered queue');
    let current=await assertContext(label);assert.equal(current.advanced,undefined);assert.ok(await evaluate(`document.querySelector('[data-testid="review-outcome"]').textContent.includes('verified')`));
    assert.equal(reviewRows(first.id),otherBefore);assert.equal(pageRows(),pagesBefore);assert.equal(db.prepare('SELECT verified_by FROM document_reviews WHERE page_id=?').get(first.id).verified_by,'ui-owner');
    await screenshot(`ready-${label}`,width);
    // Simulate a concurrent edit only inside the temporary fixture, leaving the
    // already-rendered revision token stale. The rejected review must not advance.
    data.savePage(second.id,{content:JSON.stringify([{id:'concurrent-fixture',type:'paragraph',props:{},content:[{type:'text',text:'Concurrent synthetic change',styles:{}}],children:[]}]),by:'ui-owner'});
    const staleBefore=snapshot();await submit(true);
    await waitFor(`new URLSearchParams(location.search).has('error') && document.querySelector('[role="alert"]')`,'stale revision rejection');
    current=await assertContext(label);assert.equal(current.page,second.id);assert.equal(current.advanced,undefined);assert.equal(current.saved,undefined);assert.equal(snapshot(),staleBefore,'Stale review does not write or advance');
    assert.equal(await evaluate(`document.querySelector('[data-testid="quality-selected-page"] h2').textContent`),second.title);
    otherBefore=reviewRows(second.id);pagesBefore=pageRows();await submit(true);
    await waitFor(`new URLSearchParams(location.search).get('advanced')==='1' && document.querySelector('[data-testid="quality-selected-page"] h2')?.textContent===${JSON.stringify(last.title)}`,'verify and next matching page');
    current=await assertContext(label);assert.equal(current.page,last.id);assert.equal(reviewRows(second.id),otherBefore);assert.equal(pageRows(),pagesBefore);
    const secondReview=db.prepare('SELECT * FROM document_reviews WHERE page_id=?').get(second.id);assert.equal(secondReview.verified_by,'ui-owner');assert.equal(secondReview.due_at,Date.parse(due+'T23:59:59.999Z'));
    assert.equal(db.prepare('SELECT verified_at FROM document_reviews WHERE page_id=?').get(last.id).verified_at,null);
    assert.ok(await evaluate(`document.querySelector('[data-testid="review-outcome"]').textContent.includes('next matching document')`));
    await screenshot(`next-${label}`,width);
    otherBefore=reviewRows(last.id);pagesBefore=pageRows();await submit(true);
    await waitFor(`new URLSearchParams(location.search).get('completed')==='1' && document.querySelector('[data-testid="review-outcome"]')?.textContent?.includes('No other documents') && document.querySelector('[data-testid="quality-selected-page"]')===null`,'queue exhausted');
    current=await assertContext(label);assert.equal(current.page,last.id);assert.equal(reviewRows(last.id),otherBefore);assert.equal(pageRows(),pagesBefore);
    assert.ok(await evaluate(`document.body.innerText.includes('No other matching documents')`));assert.ok(await evaluate(`document.body.innerText.includes('nothing else has been verified or published')`));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM pages WHERE space_id=? AND published!=0').get(space.id).n,0,'No review action publishes documents');
    await screenshot(`complete-${label}`,width);await settle();
    const added=data.createPage({spaceId:space.id,title:`${label} review new arrival`});
    db.prepare('INSERT INTO document_reviews(page_id,owner_id,due_at) VALUES(?,?,?)').run(added.id,'ui-owner',Date.now()+30*86400000);
    const refreshPath=await evaluate('location.pathname+location.search');await visit(refreshPath);
    await waitFor(`document.querySelector('[data-testid="review-outcome"]')?.textContent?.includes('The queue has changed') && document.querySelector('[data-testid="quality-selected-page"] h2')?.textContent===${JSON.stringify(`${label} review new arrival`)}`,'completion refresh reflects current queue');
    assert.ok(!await evaluate(`document.body.innerText.includes('No other matching documents')`));await settle();
    results.push({viewport:label,ordinaryContext:true,verified:3,staleRejected:true,oneReviewAtATime:true,bodyAndPublicationUnchanged:true,completed:true});
    console.log(`PASS ${label}: ordinary context, stale rejection, verify-next one at a time, unchanged writing/publication, completion and screenshots`);
  }
  assert.deepEqual(errors,[],'Browser console/runtime errors');
  summary={ok:true,version:expected,screenshots:6,viewports:[1440,390],results,consoleErrors:errors,canceledInterceptions,fixture:'synthetic only'};

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
console.log(`PASS review-next UI; artifacts: ${output}`);

