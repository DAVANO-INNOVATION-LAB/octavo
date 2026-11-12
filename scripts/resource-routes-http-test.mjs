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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-resource-http-'));
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
  const fixtures = [];
  for (const [name, visibility, tenanted] of [['private', 'private', false], ['public', 'public', false], ['tenant', 'public', true]]) {
    let space = data.createSpace({ name: `HTTP ${name}`, visibility });
    if (tenanted) tenants.setSpaceTenant(space.id, tenant.id);
    for (const [who, role] of [['owner', 'admin'], ['reader', 'reader'], ['agent', 'admin'], ['excluded', 'admin']]) roles.setSpaceMember(space.id, who, role);
    space = data.getSpace(space.id);
    const pages = [false, true].map(published => {
      const marker = `HTTP_${name}_${published ? 'PUBLISHED' : 'DRAFT'}_PRIVATE_MARKER`;
      const page = data.createPage({ spaceId: space.id, title: marker, published,
        content: JSON.stringify([{ id: marker, type: 'paragraph', content: [{ type: 'text', text: marker, styles: {} }], children: [] }]) });
      data.snapshotNow(page.id);
      return { ...page, marker, version: data.listVersions(page.id)[0].id };
    });
    fixtures.push({ space, pages });
  }
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
  const privateCache = response => {
    assert.match(response.headers.get('cache-control') ?? '', /private/);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  };
  let checks = 0;
  // Tenant public visibility never bypasses tenant membership on exports.
  for (const fixture of fixtures) for (const page of fixture.pages) {
    for (const who of [null, 'owner', 'reader', 'outsider', 'excluded', 'admin']) {
      const allowed = who === 'admin' || ((fixture.space.visibility === 'public' && !fixture.space.tenant_id || ['owner', 'reader'].includes(who) || who === 'excluded' && !fixture.space.tenant_id) && (page.published || ['owner', 'excluded'].includes(who)));
      const response = await request(`/api/pages/${page.id}/export`, who), body = await response.text();
      assert.equal(response.status, allowed ? 200 : 401, lastRequest);
      if (allowed) { assert.ok(body.includes(page.marker)); privateCache(response); }
      else assert.ok(!body.includes(page.marker));
      checks++;
    }
  }
  const uploads = require('../src/lib/uploads.ts'), { UPLOADS_DIR } = require('../src/lib/db.ts');
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const files = [
    { name: 'privatefile.csv', fixture: fixtures[0], published: true },
    { name: 'tenantfile.csv', fixture: fixtures[2], published: true },
    { name: 'draftfile.csv', fixture: fixtures[1], published: false },
    { name: 'publicfile.csv', fixture: fixtures[1], published: true },
    { name: 'legacyfile.csv', fixture: fixtures[1], published: true, legacy: true },
  ];
  for (const f of files) {
    f.marker = `SECRET_${f.name}_MARKER`;
    f.bytes = `x,y,label\n1,2,${f.marker}\n`;
    fs.writeFileSync(path.join(UPLOADS_DIR, f.name), f.bytes);
    if (!f.legacy) uploads.recordUpload(f.name, 'owner', f.fixture.space.id);
    data.createPage({ spaceId: f.fixture.space.id, title: `Attachment ${f.name}`, published: f.published,
      content: JSON.stringify([{ id: 'f', type: 'file', props: { url: `/api/files/${f.name}` }, children: [] }]) });
    for (const who of [null, 'owner', 'reader', 'outsider', 'excluded', 'admin']) {
      const actor = who ? { id: who, role: who === 'admin' ? 'admin' : 'member' } : null;
      const allowed = uploads.canReadUpload(actor, f.name);
      // Exercise authorization before range parsing, full bytes, and cache policy.
      for (const range of [null, 'bytes=0-4']) {
        const response = await request(`/api/files/${f.name}`, who, { headers: range ? { range } : {} });
        const body = await response.text();
        assert.equal(response.status, allowed ? range ? 206 : 200 : 404, lastRequest);
        if (allowed) {
          assert.equal(body, range ? f.bytes.slice(0, 5) : f.bytes);
          privateCache(response); assert.match(response.headers.get('vary') ?? '', /Cookie/i);
          if (range) assert.equal(response.headers.get('content-range'), `bytes 0-4/${Buffer.byteLength(f.bytes)}`);
        } else assert.ok(!body.includes(f.marker));
        checks++;
      }
    }
  }
  // Explicit expectations, independent of the upload helper used for the matrix.
  for (const name of ['privatefile.csv', 'tenantfile.csv', 'draftfile.csv', 'legacyfile.csv']) {
    assert.equal((await request(`/api/files/${name}`, null)).status, 404); checks++;
  }
  assert.equal((await request('/api/files/publicfile.csv', null)).status, 200); checks++;
  assert.equal((await request('/api/files/legacyfile.csv', 'owner')).status, 404); checks++;
  assert.equal((await request('/api/files/draftfile.csv', 'reader')).status, 404); checks++;
  // Cross-space laundering cannot grant an upload's readers authority over its source.
  const privateFile = files[0], publicSpace = fixtures[1].space;
  const modelPage = data.createPage({ spaceId: publicSpace.id, title: 'Public model', published: true,
    content: JSON.stringify([{ id: 'model', type: 'model3d', props: { source: 'data', dataUrl: privateFile.name }, children: [] }]) });
  for (const who of [null, 'outsider', 'owner']) {
    const allowed = who === 'owner';
    const response = await request(`/api/spaces/${publicSpace.slug}/model?source=data&data=${privateFile.name}`, who);
    const body = await response.text();
    assert.equal(response.status, allowed ? 200 : 404); assert.equal(body.includes(privateFile.marker), allowed); checks++;
    for (const pathname of [`/${publicSpace.slug}/${modelPage.slug}`, `/${publicSpace.slug}/print`]) {
      const pageResponse = await request(pathname, who), html = await pageResponse.text();
      assert.equal(pageResponse.status, 200); assert.equal(html.includes(privateFile.marker), allowed); checks++;
    }
  }
  // Published architecture children do not reveal unpublished parent titles.
  const draftParent = data.createPage({ spaceId: publicSpace.id, title: 'SECRET_ARCHITECTURE_PARENT', published: false });
  data.createPage({ spaceId: publicSpace.id, parentId: draftParent.id, title: 'Published child', published: true });
  const architecture = await request(`/api/spaces/${publicSpace.slug}/model`, null);
  assert.equal(architecture.status, 200); assert.ok(!(await architecture.text()).includes(draftParent.title)); checks++;
  for (const fixture of fixtures) for (const page of fixture.pages) for (const who of [null, 'reader', 'outsider', 'excluded']) {
    const allowed = !!page.published && (who === 'reader' || fixture.space.visibility === 'public' && !fixture.space.tenant_id || who === 'excluded' && !fixture.space.tenant_id);
    const before = db.prepare('SELECT COUNT(*) AS n FROM feedback').get().n;
    const response = await request('/api/feedback', who, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ pageId: page.id, helpful: true, note: 'Synthetic feedback' }) });
    assert.equal(response.status, allowed ? 200 : 404, lastRequest);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feedback').get().n, before + (allowed ? 1 : 0)); checks++;
  }
  const site = require('../src/lib/sites.ts').createSite({ name: 'SECRET_UNPUBLISHED_SITE', tagline: 'SECRET_UNPUBLISHED_TAGLINE' });
  for (const who of [null, 'owner']) for (const ua of ['OctavoResourceSmoke', 'Twitterbot']) {
    const response = await request(`/sites/${site.slug}`, who, { headers: { 'user-agent': ua } }), body = await response.text();
    if (who) { assert.equal(response.status, 200); assert.ok(body.includes(site.name)); }
    else { assert.ok(!body.includes(site.name)); assert.ok(!body.includes(site.tagline)); }
    checks++;
  }
  // Same URLs re-evaluate permissions rather than serving a previously public cached object.
  const publicFile = files[3];
  data.updateSpace(publicSpace.id, { visibility: 'private' });
  assert.equal((await request(`/api/files/${publicFile.name}`, null)).status, 404); checks++;
  roles.removeSpaceMember(fixtures[0].space.id, 'owner');
  assert.equal((await request(`/api/files/${privateFile.name}`, 'owner')).status, 404); checks++;
  console.log(`PASS compiled resource routes: ${checks} export/file/range/cache/feedback/model/metadata checks using synthetic isolated data.`);

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
