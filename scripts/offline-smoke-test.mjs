// Isolated browser-tab HTTP(S) dependency smoke; NOT a host/server airgap test.
// npm run build && node scripts/offline-smoke-test.mjs
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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-offline-'));
const output = path.resolve(process.env.OCTAVO_OFFLINE_ARTIFACT_DIR || process.env.OCTAVO_UI_ARTIFACT_DIR || path.join(root, 'artifacts/offline-smoke'));
const oldDataDir = process.env.OCTAVO_DATA_DIR;
process.env.OCTAVO_DATA_DIR = path.join(temporary, 'data');
const originalLoad = Module._load, originalTs = Module._extensions['.ts'];
let db, server, chrome, ws;
const summary = { ok: false, fixture: 'synthetic only', scope: 'Single browser tab HTTP(S) requests restricted to the fixture origin; server egress, other browser targets, WebSockets and deployment network policy are not isolated by this test.', checks: [], blockedRequests: [], errors: [] };
fs.mkdirSync(output, { recursive: true });
for (const file of ['result.json', 'library.png', 'search.png', 'document.png', 'editor.png']) fs.rmSync(path.join(output, file), {force:true});
summary.startedAt = new Date().toISOString();
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
// Runner timeouts use SIGTERM before SIGKILL. Reap separately detached fixture
// groups here; killing this Node process alone would otherwise leave them alive.
let cleanupPromise, terminating;
const cleanup = () => cleanupPromise ||= (async () => {
  const cleanupErrors = [];
  try { ws?.close(); } catch (error) { cleanupErrors.push(error); }
  const stopped = await Promise.allSettled([stop(chrome), stop(server)]);
  for (const result of stopped) if (result.status === 'rejected') cleanupErrors.push(result.reason);
  try { db?.close(); } catch (error) { cleanupErrors.push(error); }
  Module._load = originalLoad;
  if (originalTs) Module._extensions['.ts'] = originalTs; else delete Module._extensions['.ts'];
  if (oldDataDir === undefined) delete process.env.OCTAVO_DATA_DIR; else process.env.OCTAVO_DATA_DIR = oldDataDir;
  try { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) { summary.ok = false; summary.cleanupErrors = cleanupErrors.map(error => String(error)); }
  if (terminating) { summary.ok = false; summary.terminatedBy = terminating; }
  summary.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(summary, null, 2) + '\n');
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Synthetic UI fixture cleanup failed');
})();
const onSignal = signal => {
  if (terminating) return;
  terminating = signal;
  summary.ok = false;
  summary.failure = `Interrupted by ${signal}`;
  void cleanup().then(
    () => process.exit(signal === 'SIGINT' ? 130 : 143),
    error => { console.error(error); process.exit(1); },
  );
};
process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);
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
  db = require('../src/lib/db.ts').getDb();
  db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)')
    .run('ui-owner', 'owner@example.test', 'Synthetic Owner', '!', 'member', Date.now());
  db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run('synthetic-ui-session', 'ui-owner', Date.now() + 3600000);
  const socket = net.createServer();
  await bounded(new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); }), 5000, 'port allocation');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const spawnLogged = (binary, args, options, name) => {
    if (terminating) throw new Error(`Interrupted by ${terminating}`);
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
  const form = new FormData(); form.set('name', 'Offline synthetic library');
  form.set('file', new Blob(['# Offline verification\n\nOfflineSentinelQuartz content remains readable without external page dependencies.']), 'offline-verification.md');
  const imported = await fetch(`${base}/api/import`, { method: 'POST', body: form, redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { cookie: 'octavo_session=synthetic-ui-session' } });
  assert.equal(imported.status, 303);
  const location = imported.headers.get('location');
  assert.ok(location?.startsWith('/') && !location.includes('error'));
  const importedUrl = new URL(location, base); assert.equal(importedUrl.origin, base);
  const slug = importedUrl.pathname.slice(1);
  const page = db.prepare('SELECT p.slug FROM pages p JOIN spaces s ON s.id=p.space_id WHERE s.slug=?').get(slug);
  assert.ok(page?.slug, 'Synthetic import must contain a page');
  const documentPath = `/${slug}/${page.slug}`;
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
  summary.browser = { product: debug.Browser, protocolVersion: debug['Protocol-Version'] };
  summary.buildId = fs.readFileSync(path.join(root, '.next/BUILD_ID'), 'utf8').trim();
  ws = new WebSocket(debug.webSocketDebuggerUrl);
  await bounded(new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }), 5000, 'CDP connection');
  let sequence = 0;
  const pending = new Map(), errors = summary.errors;
  let phase = 'probe';
  let canceledInterceptions = 0;
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) { const item = pending.get(message.id); if (item) { pending.delete(message.id); if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result); } }
    if (message.method === 'Fetch.requestPaused') {
      const url = message.params.request.url;
      const parsed = new URL(url);
      const allowed = parsed.origin === base || parsed.protocol === 'data:' || url === 'about:blank';
      if (!allowed) summary.blockedRequests.push({ url, phase });
      void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: message.params.requestId, ...(allowed ? {} : { errorReason: 'BlockedByClient' }) }, message.sessionId).catch(error => {
        // Navigation can cancel a paused request before CDP continues it.
        // This protocol race is not a page exception or an allowed network request.
        if (error.message === '{"code":-32602,"message":"Invalid InterceptionId."}') canceledInterceptions++;
        else errors.push(error.message);
      });
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map(arg => arg.value || arg.description).join(' '));
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
    await waitFor(`location.pathname + location.search === ${JSON.stringify(pathname)} && document.readyState === 'complete'`, 'navigation');
  };
  // Verify the deny mechanism before exercising application routes. .invalid is reserved
  // and the request must be rejected by CDP before any network resolution.
  const probe = 'https://octavo-offline-probe.invalid/blocked';
  const denied = await evaluate(`fetch(${JSON.stringify(probe)}).then(() => false, () => true)`);
  assert.equal(denied, true, 'External probe must fail');
  assert.ok(summary.blockedRequests.some(item => item.url === probe), 'External probe must be intercepted');
  summary.checks.push('external HTTP(S) interception probe');
  phase = 'application';
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  for (const [label, pathname, expression] of [
    ['library', '/', `document.body.innerText.includes('Offline synthetic library')`],
    ['search', '/search?q=OfflineSentinelQuartz', `document.querySelector('ol a[href="${documentPath}"]')`],
    ['document', documentPath, `document.body.innerText.includes('OfflineSentinelQuartz')`],
    ['editor', documentPath + '/edit', `document.querySelector('[contenteditable="true"]')?.innerText.includes('OfflineSentinelQuartz')`],
  ]) {
    await visit(pathname); await waitFor(expression, label + ' content');
    await evaluate('document.fonts.ready.then(() => true)');
    assert.ok(await evaluate('[...document.styleSheets].some(s => s.href && s.cssRules.length > 0)'), 'Local styles must load');
    const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(path.join(output, label + '.png'), Buffer.from(shot.data, 'base64'));
    summary.checks.push(label + ' content and local stylesheet');
    console.log(`PASS offline browser ${label}`);
  }
  assert.deepEqual(summary.blockedRequests.filter(item => item.phase === 'application'), [], 'Application attempted external requests');
  assert.deepEqual(errors, [], 'Browser console/runtime errors');
  Object.assign(summary, { ok: true, version: expected, canceledInterceptions });
} catch (error) {
  summary.failure = error.stack || String(error);
  throw error;
} finally {
  await cleanup();
}
console.log(`PASS isolated offline browser smoke; artifacts: ${output}`);

