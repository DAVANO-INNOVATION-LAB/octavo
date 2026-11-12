// CI browser QA against a version-matched standalone build and synthetic imports only.
// npm run build && node scripts/import-report-ui-test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-verification-ui-'));
const output = path.resolve(process.env.OCTAVO_UI_ARTIFACT_DIR || path.join(root, 'artifacts/provenance-verification'));
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
  for (const file of ['result.json', 'changed-desktop.png', 'changed-mobile.png', 'legacy-desktop.png', 'legacy-mobile.png']) fs.rmSync(path.join(output, file), {force:true});
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
  const slugs = [], sourceTexts = [];

  for (const [name, text] of [
    ['Engineering handbook', '# Engineering handbook\n\n[Operations runbook](runbooks/operations.md)\n\nSynthetic conversion review.'],
    ['Release checklist', '# Release checklist\n\nA clean synthetic document for import review.'],
  ]) {
    sourceTexts.push(text);
    const form = new FormData(); form.set('name', name);
    form.set('file', new Blob([text]), name.toLowerCase().replaceAll(' ', '-') + '.md');
    const response = await fetch(`${base}/api/import`, { method: 'POST', body: form, redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { cookie: 'octavo_session=synthetic-ui-session' } });
    assert.equal(response.status, 303); const location = response.headers.get('location');
    assert.ok(location?.startsWith('/') && !location.includes('error'));
    const target = new URL(location, base); assert.equal(target.origin, base); slugs.push(target.pathname.slice(1));
  }
  // Simulate an existing receipt written before provenance collection existed.
  const legacyRow = db.prepare('SELECT id, report_json FROM import_reports WHERE space_id=(SELECT id FROM spaces WHERE slug=?)').get(slugs[1]);
  const legacyReport = JSON.parse(legacyRow.report_json); delete legacyReport.provenance;
  db.prepare('UPDATE import_reports SET report_json=? WHERE id=?').run(JSON.stringify(legacyReport), legacyRow.id);
  for (const slug of slugs) {
    const denied = await fetch(`${base}/api/spaces/${slug}/import-report`, { signal: AbortSignal.timeout(5000) });
    assert.equal(denied.status, 404, 'Anonymous users cannot read receipt provenance');
    const allowed = await fetch(`${base}/api/spaces/${slug}/import-report`, { headers: { cookie: 'octavo_session=synthetic-ui-session' }, signal: AbortSignal.timeout(5000) });
    assert.equal(allowed.status, 200);
    assert.match(allowed.headers.get('cache-control'), /private.*no-store/);
    const report = await allowed.json();
    if (slug === slugs[0]) {
      assert.equal(report.provenance.schemaVersion, 1);
      assert.equal(report.provenance.source.id, report.id);
      assert.equal(report.provenance.source.sha256, crypto.createHash('sha256').update(sourceTexts[0]).digest('hex'));
      assert.equal(report.provenance.source.bytes, Buffer.byteLength(sourceTexts[0]));
      assert.equal(report.provenance.converter.name, 'octavo/importUpload');
      assert.equal(report.provenance.converter.version, expected);
      assert.equal(report.provenance.capturedAt, report.completedAt);
      const pages = db.prepare('SELECT id, content FROM pages WHERE space_id=? ORDER BY id').all(report.spaceId);
      assert.equal(report.provenance.pages.length, pages.length);
      for (const page of pages) assert.equal(report.provenance.pages.find(p => p.pageId === page.id).contentSha256, crypto.createHash('sha256').update(page.content).digest('hex'));
      assert.deepEqual(report.provenance.attachments, []);
    } else assert.equal(report.provenance, undefined, 'Legacy receipts must not fabricate provenance');
    const checkResponse = await fetch(`${base}/api/spaces/${slug}/import-report/verify`, { method: 'POST', headers: { origin: base, cookie: 'octavo_session=synthetic-ui-session' }, signal: AbortSignal.timeout(10000) });
    assert.equal(checkResponse.status, 200);
    assert.match(checkResponse.headers.get('cache-control'), /private.*no-store/);
    const verification = await checkResponse.json();
    if (slug === slugs[0]) { assert.equal(verification.status, 'checked'); assert.equal(verification.counts.unchanged, 1); }
    else assert.equal(verification.status, 'unavailable');
    const anonymous = await fetch(`${base}/api/spaces/${slug}/import-report/verify`, { method: 'POST', headers: { origin: base }, signal: AbortSignal.timeout(10000) });
    assert.equal(anonymous.status, 404);


  }
  if (httpOnly) {
    summary = { ok: true, version: expected, fixture: 'synthetic only', httpOnly: true };
    console.log('PASS compiled provenance verification HTTP checks');
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
  let canceledInterceptions = 0, verificationRequests = 0;
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) { const item = pending.get(message.id); if (item) { pending.delete(message.id); if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result); } }
    if (message.method === 'Network.requestWillBeSent' && message.params.request.url.endsWith('/import-report/verify')) verificationRequests++;
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
  const recordedSpace = db.prepare('SELECT id FROM spaces WHERE slug=?').get(slugs[0]);
  const originalPage = db.prepare('SELECT * FROM pages WHERE space_id=?').get(recordedSpace.id);
  const restorePage = () => {
    const columns = Object.keys(originalPage);
    db.prepare(`INSERT OR REPLACE INTO pages(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(key => originalPage[key]));
  };
  for (const [label, width, height] of [['desktop', 1440, 1100], ['mobile', 390, 844]]) {
    restorePage();
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: label === 'mobile' }, sessionId);
    const reportPath = `/${slugs[0]}/settings/import-report`;
    const priorRequests = verificationRequests;
    await visit(reportPath);
    await waitFor(`document.querySelector('[data-testid="verify-provenance"]')`, 'explicit verification action');
    await sleep(200);
    assert.equal(verificationRequests, priorRequests, 'No eager verification on page load');
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="verification-result"]'))`), false);
    const check = async (status, count = 1) => {
      await evaluate(`document.querySelector('[data-testid="verify-provenance"]').click()`);
      await waitFor(`document.querySelector('[data-testid="count-${status}"]')?.textContent === '${count}'`, status + ' comparison');
    };
    await check('unchanged');
    assert.equal(verificationRequests, priorRequests + 1);
    const beforeDelayed = verificationRequests;
    await evaluate(`window.originalFetch=window.fetch;window.fetch=(...args)=>new Promise(resolve=>setTimeout(()=>resolve(window.originalFetch(...args)),400));document.querySelector('[data-testid="verify-provenance"]').click();document.querySelector('[data-testid="verify-provenance"]').click()`);
    await waitFor(`document.querySelector('[data-testid="verify-provenance"]')?.disabled`, 'loading disables duplicate checks');
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="verification-result"]'))`), false, 'Loading clears stale results');
    await waitFor(`document.querySelector('[data-testid="count-unchanged"]')?.textContent === '1'`, 'delayed comparison');
    await evaluate('window.fetch=window.originalFetch;delete window.originalFetch');
    assert.equal(verificationRequests, beforeDelayed + 1, 'Repeated clicks trigger only one request');

    db.prepare('UPDATE pages SET content=? WHERE id=?').run('changed synthetic content', originalPage.id);
    await check('changed');
    assert.equal(await evaluate(`document.querySelector('[data-testid="count-unchanged"]').textContent`), '0');
    const info = await evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth,text:document.body.innerText})');
    assert.ok(info.scroll <= width + 1, `No horizontal overflow at ${label}`);
    assert.ok(info.text.includes('changed does not mean corrupted'));
    assert.ok(info.text.includes('Original upload not checked'));
    await evaluate('document.fonts.ready.then(() => true)');
    const layout = await send('Page.getLayoutMetrics', {}, sessionId);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.ceil(layout.cssContentSize.height), scale: 1 } }, sessionId);
    fs.writeFileSync(path.join(output, `changed-${label}.png`), Buffer.from(shot.data, 'base64'));
    const beforeDownloads = new Set(downloads.keys());
    await evaluate(`document.querySelector('[data-testid="download-verification"]').click()`);
    let completed;
    for (const deadline = Date.now() + 12000; Date.now() < deadline;) { completed = [...downloads.values()].find(item => !beforeDownloads.has(item.guid) && item.state === 'completed'); if (completed) break; await sleep(100); }
    assert.ok(completed, 'Verification JSON download completes');
    const saved = JSON.parse(fs.readFileSync(path.join(temporary, 'downloads', path.basename(completed.guid)), 'utf8'));
    assert.equal(saved.counts.changed, 1); assert.equal(saved.source.status, 'not_checked');
    assert.equal(completed.suggestedFilename, 'octavo-provenance-verification.json');
    // A failed retry must clear the previous successful result and download.
    await evaluate(`window.originalFetch=window.fetch; window.fetch=()=>Promise.resolve(new Response('',{status:500}));document.querySelector('[data-testid="verify-provenance"]').click()`);
    await waitFor(`document.querySelector('[data-testid="verification-status"] [role="alert"]')`, 'failed retry warning');
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="verification-result"]'))`), false);
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="download-verification"]'))`), false);
    await evaluate('window.fetch=window.originalFetch;delete window.originalFetch');
    await check('changed');
    db.prepare('DELETE FROM pages WHERE id=?').run(originalPage.id);
    await check('missing');
    const row = db.prepare('SELECT id,report_json FROM import_reports WHERE space_id=?').get(recordedSpace.id);
    const report = JSON.parse(row.report_json); const savedReport = row.report_json;
    delete report.provenance;
    db.prepare('UPDATE import_reports SET report_json=? WHERE id=?').run(JSON.stringify(report), row.id);
    await evaluate(`document.querySelector('[data-testid="verify-provenance"]').click()`);
    await waitFor(`document.querySelector('[data-testid="verification-result"]')?.textContent.includes("Verification unavailable")`, 'absent baseline not fabricated');
    db.prepare('UPDATE import_reports SET report_json=? WHERE id=?').run(savedReport, row.id);
    await visit(`/${slugs[1]}/settings/import-report`);
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-testid="verify-provenance"]'))`), false, 'Legacy report offers no misleading check');
    const legacyShot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(path.join(output, `legacy-${label}.png`), Buffer.from(legacyShot.data, 'base64'));
    console.log(`PASS ${label}: explicit-only check, unchanged/changed/missing/unavailable, export, failed retry clears stale state, recovery, legacy`);
  }
  assert.deepEqual(errors, [], 'Browser console/runtime errors');
  summary = { ok: true, version: expected, screenshots: 4, viewports: [1440, 390], consoleErrors: errors, canceledInterceptions, fixture: 'synthetic only' };
  }
} catch (error) {
  summary = { ok: false, fixture: 'synthetic only', failure: error.stack || String(error) };
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
  if (cleanupErrors.length) summary = { ...summary, ok: false, cleanupErrors: cleanupErrors.map(String) };
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(summary, null, 2));
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Synthetic UI fixture cleanup failed');
}
console.log(`PASS provenance verification ${httpOnly ? 'HTTP' : 'UI'}; artifacts: ${output}`);
