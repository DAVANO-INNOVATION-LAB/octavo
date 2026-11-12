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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-access-http-'));
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
  for (const fixture of fixtures) for (const page of fixture.pages) {
    const pathname = `/${fixture.space.slug}/${page.slug}`;
    for (const who of [null, 'owner', 'reader', 'outsider', 'agent', 'excluded', 'admin']) {
      const read = roles.canReadSpace(who ? { id: who, role: who === 'agent' ? 'agent' : who === 'admin' ? 'admin' : 'member' } : null, fixture.space);
      const write = read && ['owner', 'admin', ...(fixture.space.tenant_id ? [] : ['excluded'])].includes(who);
      for (const suffix of ['/edit', '/history', `/history/${page.version}`, '/history/compare']) {
        for (const rsc of [false, true]) {
          const response = await request(pathname + suffix + (rsc ? '?_rsc' : ''), who, { headers: rsc ? { RSC: '1' } : {} });
          const body = await response.text();
          if (write) { assert.equal(response.status, 200, `${who} ${pathname}${suffix} RSC=${rsc} location=${response.headers.get('location')}`); assert.ok(body.includes(page.marker)); privateCache(response); }
          else {
            // Next may stream its navigation denial after the HTTP headers.
            assert.ok(response.status >= 300 || /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_REDIRECT;/.test(body), `${who} ${pathname}${suffix} RSC=${rsc} status=${response.status} must signal denial`);
            assert.ok(!body.includes(page.marker), 'denied HTML/RSC contains no page data');
          }
          checks++;
        }
      }
      const raw = await request(pathname + '/raw', who);
      const rawBody = await raw.text();
      if (read && (page.published || write)) { assert.equal(raw.status, 200); privateCache(raw); assert.ok(rawBody.includes(page.marker)); }
      else { assert.equal(raw.status, 404); assert.ok(!rawBody.includes(page.marker)); }
      checks++;
      for (const ua of ['OctavoAccessSmoke', 'Twitterbot']) {
        const response = await request(pathname, who, { headers: { 'user-agent': ua } });
        const body = await response.text();
        if (read && (page.published || write)) { assert.equal(response.status, 200); assert.ok(body.includes(page.marker)); privateCache(response); }
        else assert.ok(!body.includes(page.marker), 'denied reader/bot metadata contains no page data');
        checks++;
      }
    }
  }
  const snapshot = () => JSON.stringify(['spaces', 'pages', 'page_versions', 'space_members', 'audit_log'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  for (const fixture of fixtures) {
    const pathname = `/${fixture.space.slug}/settings`;
    const response = await request(pathname, 'owner'); privateCache(response);
    const html = await response.text();
    const forms = html.match(/<form\b[\s\S]*?<\/form>/g) ?? [];
    for (const field of ['visibility', 'group']) {
      const markup = forms.find(form => form.includes(`name="${field}"`));
      assert.ok(markup, `Compiled ${field} form exists`);
      const actionId = markup.match(/name="(\$ACTION_ID_[^"]+)"/)?.[1];
      assert.ok(actionId, 'Compiled server action reference exists');
      for (const who of [null, 'outsider', 'reader', 'agent', ...(fixture.space.tenant_id ? ['excluded'] : [])]) {
        const before = snapshot();
        const form = new FormData();
        for (const [key, value] of Object.entries({ [actionId]: '', slug: fixture.space.slug, name: 'DENIED_MARKER', visibility: 'public', group: 'DENIED_MARKER' })) form.set(key, value);
        const denied = await request(pathname, who, { method: 'POST', headers: { origin: base }, body: form });
        assert.equal(denied.status, 303); assert.equal(snapshot(), before, 'denied HTTP server action changes no rows or audit');
        assert.ok(!(await denied.text()).includes('DENIED_MARKER'));
        checks++;
      }
      const form = new FormData();
      for (const [key, value] of Object.entries({ [actionId]: '', slug: fixture.space.slug, name: 'ALLOWED_MARKER', visibility: 'public', group: 'ALLOWED_MARKER' })) form.set(key, value);
      assert.equal((await request(pathname, 'owner', { method: 'POST', headers: { origin: base }, body: form })).status, 303);
      assert.equal(field === 'visibility' ? data.getSpace(fixture.space.id).name : data.getSpace(fixture.space.id).variant_group, 'ALLOWED_MARKER');
      data.updateSpace(fixture.space.id, fixture.space);
      data.setSpaceVariant(fixture.space.id, { group: '', label: '', kind: 'version', position: 0 });
      checks++;
    }
    for (const who of [null, 'reader', 'outsider', 'agent', ...(fixture.space.tenant_id ? ['excluded'] : [])]) {
      const denied = await request(pathname, who), body = await denied.text();
      assert.ok(denied.status >= 300); assert.ok(!body.includes(fixture.pages[0].marker)); checks++;
    }
  }
  // Direct version restore submits the compiled history form, independently of its UI gate.
  for (const fixture of [fixtures[0], fixtures[2]]) {
    const page = fixture.pages[1], pathname = `/${fixture.space.slug}/${page.slug}/history/${page.version}`;
    const response = await request(pathname, 'owner');
    const formMarkup = ((await response.text()).match(/<form\b[\s\S]*?<\/form>/g) ?? []).find(form => form.includes('name="versionId"'));
    const actionId = formMarkup?.match(/name="(\$ACTION_ID_[^"]+)"/)?.[1];
    assert.ok(actionId);
    data.savePage(page.id, { title: 'Current HTTP restore fixture' });
    for (const who of [null, 'outsider', 'reader', 'agent', ...(fixture.space.tenant_id ? ['excluded'] : [])]) {
      const before = snapshot(), form = new FormData();
      for (const [key, value] of Object.entries({ [actionId]: '', versionId: page.version, space: fixture.space.slug })) form.set(key, value);
      assert.equal((await request(pathname, who, { method: 'POST', headers: { origin: base }, body: form })).status, 303);
      assert.equal(snapshot(), before, 'denied HTTP restore changes no content/history/audit'); checks++;
    }
    const form = new FormData();
    for (const [key, value] of Object.entries({ [actionId]: '', versionId: page.version, space: fixture.space.slug })) form.set(key, value);
    assert.equal((await request(pathname, 'owner', { method: 'POST', headers: { origin: base }, body: form })).status, 303);
    assert.equal(data.getPage(page.id).title, page.title); checks++;
  }
  // A visitor cookie cannot reactivate retained grants after tenant access ends.
  const visited = fixtures[2], visitor = require('../src/lib/visitors.ts').createVisitorToken({ spaceId: visited.space.id, label: 'HTTP visitor', days: 1, createdBy: 'owner' });
  const visitHeaders = { cookie: `octavo_session=synthetic-excluded; octavo_visit=${visitor.token}` };
  for (const suffix of ['', '/raw']) {
    const denied = await request(`/${visited.space.slug}/${visited.pages[0].slug}${suffix}`, null, { headers: visitHeaders });
    assert.ok(!(await denied.text()).includes(visited.pages[0].marker)); checks++;
    const published = await request(`/${visited.space.slug}/${visited.pages[1].slug}${suffix}`, null, { headers: visitHeaders });
    assert.equal(published.status, 200); privateCache(published); assert.ok((await published.text()).includes(visited.pages[1].marker)); checks++;
  }
  for (const suffix of ['', '/print']) {
    const response = await request(`/${visited.space.slug}${suffix}`, null, { headers: visitHeaders });
    const body = await response.text(); assert.equal(response.status, 200); privateCache(response);
    assert.ok(!body.includes(visited.pages[0].marker)); assert.ok(body.includes(visited.pages[1].marker)); checks++;
  }
  const image = async (fixture, page, who) => {
    const response = await request(`/${fixture.space.slug}/${page.slug}/opengraph-image`, who);
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /image\/png/); privateCache(response);
    checks++; return Buffer.from(await response.arrayBuffer());
  };
  const generic = await image(fixtures[0], fixtures[0].pages[1], null);
  fs.writeFileSync(path.join(temporary, 'generic-card.png'), generic);
  for (const fixture of [fixtures[0], fixtures[2]]) for (const who of [null, 'owner']) assert.deepEqual(await image(fixture, fixture.pages[1], who), generic);
  assert.deepEqual(await image(fixtures[1], fixtures[1].pages[0], 'owner'), generic);
  // Use a human-readable title for the retained visual QA image.
  data.savePage(fixtures[1].pages[1].id, { title: 'Public documentation fixture' });
  const publicCard = await image(fixtures[1], fixtures[1].pages[1], null);
  fs.writeFileSync(path.join(temporary, 'public-card.png'), publicCard);
  assert.notDeepEqual(publicCard, generic);
  data.updateSpace(fixtures[1].space.id, { visibility: 'private' });
  assert.deepEqual(await image(fixtures[1], fixtures[1].pages[1], 'owner'), generic, 'same URL rechecks policy after public-to-private change');
  data.updateSpace(fixtures[1].space.id, { visibility: 'public' });
  console.log(`PASS compiled space access: ${checks} HTML/RSC/metadata/action/image/cache checks against the version-matched production build.`);
  // Preserve the exact candidate for the existing integration/import suites, using synthetic data only.
  if (process.env.OCTAVO_ACCESS_FULL === '1') {
    // Legacy integration chooses the first private page and expects it in search.
    // The security smoke intentionally seeds that page as a draft; publish/index
    // it only after all draft-denial checks have completed.
    data.savePage(fixtures[0].pages[0].id, { published: true });
    fs.copyFileSync('package.json', path.join(temporary, 'package.json'));
    fs.symlinkSync(path.resolve('src'), path.join(temporary, 'src'));
    fs.symlinkSync(path.resolve('node_modules'), path.join(temporary, 'node_modules'));
    for (const script of ['import-test.mjs', 'integration.mjs', 'tenant-test.mjs']) {
      const child = spawn(process.execPath, [path.resolve('scripts', script), base], { cwd: temporary, env: process.env, stdio: 'inherit' });
      const [code] = await once(child, 'exit');
      assert.equal(code, 0, `${script} passed against the isolated production instance`);
    }
  }
  if (process.env.OCTAVO_ACCESS_KEEP_FIXTURES === '1') {
    console.log(`Synthetic HTTP data: ${temporary}`);
    fs.copyFileSync('package.json', path.join(temporary, 'package.json'));
  }

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
  if (process.env.OCTAVO_ACCESS_KEEP_FIXTURES !== '1') fs.rmSync(temporary, { recursive: true, force: true });
}
