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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-import-search-http-'));
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
  for (const name of ['owner', 'reader', 'outsider', 'agent', 'excluded', 'admin']) {
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
  let checks = 0;
  const search = async (term, who) => {
    const response = await request(`/api/search?q=${encodeURIComponent(term)}`, who);
    assert.equal(response.status, 200, lastRequest);
    const payload = await response.json(); assert.ok(Array.isArray(payload.results)); checks++;
    return payload.results;
  };
  const formResponse = await request('/import/openapi', 'owner');
  assert.equal(formResponse.status, 200);
  const forms = (await formResponse.text()).match(/<form\b[\s\S]*?<\/form>/g) ?? [];
  const markup = forms.find(form => form.includes('name="spec"'));
  const actionId = markup?.match(/name="(\$ACTION_ID_[^"]+)"/)?.[1];
  assert.ok(actionId, 'Compiled OpenAPI import form supplies the action ID'); checks++;
  const apiTitle = 'Quasarreferencefixture', apiBody = 'Nebulaoperationfixture';
  const spec = JSON.stringify({ openapi: '3.0.3', info: { title: 'Synthetic API', version: '1.0' }, paths: {
    '/items': { get: { summary: apiTitle, description: apiBody, responses: { '200': { description: 'Synthetic success' } } } }
  } });
  const form = new FormData(); form.set(actionId, ''); form.set('name', 'Synthetic OpenAPI search'); form.set('spec', spec);
  const imported = await request('/import/openapi', 'owner', { method: 'POST', headers: { origin: base }, body: form });
  assert.equal(imported.status, 303); const apiLocation = imported.headers.get('location');
  assert.ok(apiLocation && !apiLocation.includes('error=')); checks++;
  const apiSpace = data.getSpaceBySlug(new URL(apiLocation, base).pathname.split('/').filter(Boolean)[0]);
  assert.ok(apiSpace); assert.equal(apiSpace.visibility, 'private');
  const apiPage = db.prepare('SELECT * FROM pages WHERE space_id=? AND title=?').get(apiSpace.id, apiTitle);
  assert.ok(apiPage, 'Operation was imported'); assert.equal(apiPage.published, 1);
  const mdTitle = 'Pulsarmarkdownfixture', mdBody = 'Auroratextfixture';
  const upload = new FormData(); upload.set('name', 'Synthetic Markdown search');
  upload.set('file', new Blob([`# ${mdTitle}\n\n${mdBody} is synthetic imported content.\n`], { type: 'text/markdown' }), 'synthetic.md');
  const mdResponse = await request('/api/import', 'owner', { method: 'POST', body: upload });
  assert.equal(mdResponse.status, 303); const mdLocation = mdResponse.headers.get('location');
  assert.ok(mdLocation && !mdLocation.includes('error=')); checks++;
  const mdSpace = data.getSpaceBySlug(new URL(mdLocation, base).pathname.split('/').filter(Boolean)[0]); assert.ok(mdSpace);
  const mdPage = db.prepare('SELECT * FROM pages WHERE space_id=? AND title=?').get(mdSpace.id, mdTitle);
  assert.ok(mdPage); assert.equal(mdPage.published, 1);
  const fixtures = [{ space: apiSpace, page: apiPage, title: apiTitle, body: apiBody }, { space: mdSpace, page: mdPage, title: mdTitle, body: mdBody }];
  for (const fixture of fixtures) {
    // The committed import is searchable immediately, without saving or reindexing it manually.
    for (const term of [fixture.title, fixture.body]) {
      assert.ok((await search(term, 'owner')).some(p => p.page_id === fixture.page.id), `owner finds imported ${term}`);
    }
    // Set explicit fixture policy for each phase; assert exact page identities, not total result counts.
    for (const policy of ['private', 'public', 'tenant']) {
      data.updateSpace(fixture.space.id, { visibility: policy === 'private' ? 'private' : 'public' });
      tenants.setSpaceTenant(fixture.space.id, policy === 'tenant' ? tenant.id : null);
      roles.setSpaceMember(fixture.space.id, 'reader', 'reader');
      for (const who of [null, 'owner', 'reader', 'outsider']) for (const term of [fixture.title, fixture.body]) {
        const allowed = policy === 'public' || who === 'owner' || who === 'reader';
        const results = await search(term, who);
        assert.equal(results.some(p => p.page_id === fixture.page.id), allowed, `${policy} ${who} ${term}`);
      }
    }
    // Unpublishing removes imported title/body from search even for editors and instance admins.
    data.savePage(fixture.page.id, { published: false });
    for (const who of [null, 'owner', 'reader', 'outsider', 'admin']) for (const term of [fixture.title, fixture.body]) {
      assert.ok(!(await search(term, who)).some(p => p.page_id === fixture.page.id), `draft excluded for ${who}`);
    }
    // Publishing restores the committed derived index without a separate repair call.
    data.savePage(fixture.page.id, { published: true });
    assert.ok((await search(fixture.body, 'owner')).some(p => p.page_id === fixture.page.id));
    assert.ok(!(await search(fixture.body, null)).some(p => p.page_id === fixture.page.id), 'tenant stays hidden from anonymous');
  }
  console.log(`PASS compiled import search: ${checks} form/import/title/body/visibility/draft checks using isolated synthetic data.`);

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
