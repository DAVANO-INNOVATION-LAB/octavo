// The actual action and page guard, real SQLite/helpers, synthetic input only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = path.resolve('src');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-openapi-import-'));
process.env.OCTAVO_DATA_DIR = temporary;
const originalLoad = Module._load;
const originalTs = Module._extensions['.ts'], originalTsx = Module._extensions['.tsx'];
const originalFetch = globalThis.fetch, originalError = console.error;
const member = { id: 'importer', email: 'importer@example.test', name: 'Importer', role: 'member' };
const admin = { id: 'admin', email: 'admin@example.test', name: 'Admin', role: 'admin' };
const outsider = { id: 'outsider', email: 'outsider@example.test', name: 'Outsider', role: 'member' };
const agent = { id: 'agent', email: 'agent@example.test', name: 'Agent', role: 'agent' };
let user = member, db, cacheFails = false, forwardingFails = false, responseFails = false, fetches = 0;
const cachePaths = [], forwarded = [], logs = [], redirects = [];
class Redirect extends Error {
  constructor(location) { super('NEXT_REDIRECT'); this.location = location; this.digest = `NEXT_REDIRECT;replace;${location};303;`; }
}
Module._load = function(name, parent, main) {
  if (name === 'server-only') return {};
  if (name === 'next/navigation') return { redirect: location => {
    redirects.push(location);
    if (responseFails) throw new Error('synthetic response failure');
    throw new Redirect(location);
  } };
  if (name === 'next/cache') return { revalidatePath: value => {
    assert.equal(db.inTransaction, false, 'cache work is after commit');
    cachePaths.push(value);
    if (cacheFails) throw new Error('synthetic cache failure');
  } };
  if (name === 'next/headers') return { cookies: async () => ({ get: () => undefined }), headers: async () => new Map() };
  if (name === '@/lib/auth') return { currentUser: async () => user };
  if (name === '@/components/SiteHeader') return { SiteHeader: () => null };
  if (name === './audit-forward') return { forwardAudit: entry => {
    assert.equal(db.inTransaction, false, 'audit forwarding is after outer commit');
    assert.ok(db.prepare('SELECT 1 FROM audit_log WHERE id = ?').get(entry.id));
    if (forwardingFails) throw new Error('synthetic forwarding failure');
    forwarded.push(entry);
  } };
  if (name.startsWith('@/')) name = path.join(root, name.slice(2));
  return originalLoad.call(this, name, parent, main);
};
Module._extensions['.ts'] = Module._extensions['.tsx'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText, file);
globalThis.fetch = () => { fetches++; throw new Error('Unexpected external request'); };
console.error = (...args) => logs.push(args);
try {
  const database = require('../src/lib/db.ts');
  db = database.getDb();
  const data = require('../src/lib/data.ts');
  const roles = require('../src/lib/roles.ts');
  const groups = require('../src/lib/groups.ts');
  const tenants = require('../src/lib/tenants.ts');
  const { verifyChain } = require('../src/lib/audit.ts');
  const action = require('../src/app/actions.ts').importOpenApiAction;
  const page = require('../src/app/import/openapi/page.tsx').default;
  const { generatePages } = require('../src/lib/openapi-pages.ts');
  for (const u of [member, admin, outsider, agent]) db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)')
    .run(u.id, u.email, u.name, '!', u.role, Date.now());
  fs.mkdirSync(database.UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(path.join(database.UPLOADS_DIR, 'unrelated.png'), 'unrelated bytes');
  const privateSpace = data.createSpace({ name: 'Existing private' });
  const publicSpace = data.createSpace({ name: 'Existing public', visibility: 'public' });
  roles.setSpaceMember(privateSpace.id, outsider.id, 'admin');
  const oldPage = data.createPage({ spaceId: privateSpace.id, title: 'Retained page', published: true,
    content: JSON.stringify([{ type: 'image', props: { url: '/api/files/unrelated.png' }, children: [] }]) });
  data.savePage(oldPage.id, { published: true });
  data.snapshotNow(oldPage.id);
  const groupSpace = data.createSpace({ name: 'Existing group space' });
  const group = groups.createGroup('Existing editors');
  groups.addGroupMember(group.id, member.id);
  groups.setGroupGrant(group.id, groupSpace.id, 'editor');
  const capped = data.createSpace({ name: 'Space-local agent ceiling' });
  roles.setSpaceMember(capped.id, member.id, 'agent');
  const tenant = tenants.createTenant('Existing tenant');
  tenants.setSpaceTenant(publicSpace.id, tenant.id);
  const tables = ['spaces', 'pages', 'page_versions', 'space_members', 'audit_log', 'uploads', 'upload_refs', 'page_links', 'pages_fts',
    'users', 'groups', 'group_members', 'group_space_roles', 'tenants', 'tenant_members'];
  const rows = () => tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const files = () => fs.readdirSync(database.UPLOADS_DIR).sort().map(name => [name, fs.readFileSync(path.join(database.UPLOADS_DIR, name)).toString('hex')]);
  const snapshot = () => JSON.stringify([rows(), files()]);
  const existingIds = [privateSpace.id, publicSpace.id, groupSpace.id, capped.id];
  const unchanged = () => JSON.stringify([
    existingIds.map(id => db.prepare('SELECT * FROM spaces WHERE id = ?').get(id)),
    existingIds.map(id => db.prepare('SELECT * FROM space_members WHERE space_id = ? ORDER BY rowid').all(id)),
    ['group_members', 'group_space_roles', 'tenant_members', 'users'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    db.prepare('SELECT * FROM pages WHERE id = ?').get(oldPage.id), files(),
  ]);
  const existingBefore = unchanged();
  const spec = JSON.stringify({ openapi: '3.0.3', info: { title: 'Fixture API', version: '1.2.3' },
    servers: [{ url: 'https://never-request.example.test' }], tags: [{ name: 'Pets' }],
    paths: { '/pets': { get: { summary: 'List pets', tags: ['Pets'], parameters: [{ $ref: '#/components/parameters/limit' }],
      responses: { '200': { description: 'Pets', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } } },
      post: { summary: 'Create pet', tags: ['Pets'], requestBody: { content: { 'application/json': { schema: { $ref: 'https://never-request.example.test/schema.json' } } } }, responses: { '201': { description: 'Created' } } } } },
    components: { parameters: { limit: { name: 'limit', in: 'query', schema: { type: 'integer' } } }, schemas: { Pet: { type: 'object', properties: { name: { type: 'string' } } } } } });
  const yaml = 'openapi: 3.0.3\ninfo:\n  title: YAML fixture\n  version: "2.0"\npaths:\n  /status:\n    get:\n      summary: Read status\n      responses:\n        "200":\n          description: OK\n';
  const form = (source = spec, name = '') => { const value = new FormData(); value.set('spec', source); value.set('name', name); return value; };
  const redirected = async invoke => {
    try { await invoke(); assert.fail('Expected a Next redirect signal'); }
    catch (error) { if (!(error instanceof Redirect)) throw error; return error.location; }
  };
  const attempt = (source = spec, name = '') => redirected(() => action(form(source, name)));
  const newSpace = location => { assert.doesNotMatch(location, /error=/); const space = data.getSpaceBySlug(location.slice(1)); assert.ok(space); return space; };
  for (const who of [null, agent]) {
    user = who;
    const before = snapshot();
    assert.equal(await redirected(() => action({ get() { throw new Error('Denied import must not parse input'); } })), who ? '/' : '/login');
    assert.equal(await redirected(() => page({ searchParams: Promise.resolve({}) })), who ? '/' : '/login');
    assert.equal(snapshot(), before, 'denied users create no rows/files');
  }
  user = member;
  for (const invalid of ['', '[]', 'null', '{broken', 'not an API']) {
    const before = snapshot(), forwardedBefore = forwarded.length;
    assert.match(await attempt(invalid), /^\/import\/openapi\?error=/);
    assert.equal(snapshot(), before, 'malformed specification writes nothing');
    assert.equal(forwarded.length, forwardedBefore);
  }
  // Real database faults at each boundary, including after earlier pages exist.
  for (const [table, condition] of [['spaces', ''], ['space_members', ''], ['pages', "WHEN NEW.title = 'Create pet'"],
    ['pages', 'WHEN NEW.published = 1'], ['audit_log', '']]) {
    const before = snapshot(), forwardedBefore = forwarded.length, cacheBefore = cachePaths.length;
    db.exec(`CREATE TEMP TRIGGER fail_openapi BEFORE INSERT ON ${table} ${condition} BEGIN SELECT RAISE(ABORT, 'synthetic OpenAPI failure'); END`);
    try {
      assert.match(decodeURIComponent(await attempt()), /synthetic OpenAPI failure/);
      assert.equal(snapshot(), before, `${table} failure rolls back all rows/indexes/history/refs/files`);
      assert.equal(forwarded.length, forwardedBefore);
      assert.equal(cachePaths.length, cacheBefore);
    } finally { db.exec('DROP TRIGGER fail_openapi'); }
  }
  db.exec('CREATE TABLE import_deferred (user_id TEXT REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED)');
  db.exec("CREATE TEMP TRIGGER defer_openapi_failure AFTER INSERT ON audit_log BEGIN INSERT INTO import_deferred VALUES ('missing-user'); END");
  {
    const before = snapshot(), forwardedBefore = forwarded.length;
    try {
      assert.match(decodeURIComponent(await attempt()), /FOREIGN KEY/);
      assert.equal(snapshot(), before, 'outer commit failure rolls back successful pages, membership and audit');
      assert.equal(db.prepare('SELECT count(*) AS n FROM import_deferred').get().n, 0);
      assert.equal(forwarded.length, forwardedBefore, 'failed commit never forwards an event');
    } finally { db.exec('DROP TRIGGER defer_openapi_failure'); }
  }
  const withoutIds = value => JSON.parse(JSON.stringify(value), (key, val) => key === 'id' ? undefined : val);
  for (const who of [member, admin]) {
    user = who;
    assert.ok(await page({ searchParams: Promise.resolve({}) }), 'human page remains available');
    const forwardBefore = forwarded.length;
    const space = newSpace(await attempt(spec, who === admin ? 'Admin reference' : ''));
    assert.equal(space.name, who === admin ? 'Admin reference' : 'Fixture API');
    assert.equal(space.description, 'Version 1.2.3');
    assert.equal(space.visibility, 'private');
    assert.equal(space.tenant_id, null);
    assert.equal(roles.spaceRole(who.id, space.id), 'admin');
    assert.equal(roles.canReadSpace(who, space), true);
    assert.equal(roles.canEditSpace(who, space.id), true);
    assert.equal(roles.canAdminSpace(who, space.id), true);
    assert.equal(roles.canAdminSpace(admin, space.id), true);
    for (const denied of [outsider, agent, null]) {
      assert.equal(roles.canReadSpace(denied, space), false);
      assert.equal(roles.canEditSpace(denied, space.id), false);
      assert.equal(roles.canAdminSpace(denied, space.id), false);
    }
    const pages = db.prepare('SELECT * FROM pages WHERE space_id = ?').all(space.id);
    const expected = generatePages(spec).pages;
    assert.equal(pages.length, expected.length);
    for (const generated of expected) {
      const actual = pages.find(item => item.title === generated.title);
      assert.ok(actual);
      assert.equal(actual.published, 1);
      assert.deepEqual(withoutIds(JSON.parse(actual.content)), withoutIds(generated.blocks));
      if (generated.parent) assert.equal(pages.find(item => item.id === actual.parent_id).title, 'Pets');
      else assert.equal(actual.parent_id, null);
      assert.ok(actual.content_text.length > 0, 'generated content remains readable');
    }
    assert.equal(forwarded.length, forwardBefore + 1);
    const audit = forwarded.at(-1);
    assert.equal(audit.actor_id, who.id);
    assert.equal(audit.space_id, space.id);
    assert.equal(audit.action, 'space.created');
    assert.deepEqual(JSON.parse(audit.detail), { from: 'openapi', operations: 2 });
    assert.deepEqual(cachePaths.slice(-2), ['/', `/${space.slug}`]);
  }
  user = member;
  assert.equal(newSpace(await attempt(yaml)).name, 'YAML fixture');
  for (const mode of ['cache', 'forward', 'response']) {
    const countBefore = db.prepare('SELECT count(*) AS n FROM spaces').get().n;
    cacheFails = mode === 'cache'; forwardingFails = mode === 'forward'; responseFails = mode === 'response';
    try {
      if (responseFails) {
        const beforeRedirects = redirects.length;
        await assert.rejects(action(form(spec, 'Retained response')), /synthetic response failure/);
        assert.equal(redirects.length, beforeRedirects + 1, 'no misleading retry/error redirect after commit');
        newSpace(redirects.at(-1));
      } else newSpace(await attempt(spec, `Retained ${mode}`));
    } finally { cacheFails = false; forwardingFails = false; responseFails = false; }
    assert.equal(db.prepare('SELECT count(*) AS n FROM spaces').get().n, countBefore + 1);
  }
  assert.ok(logs.some(args => String(args[0]).includes('cache revalidation failed')));
  assert.ok(logs.some(args => String(args[0]).includes('audit forwarding failed')));
  assert.equal(unchanged(), existingBefore, 'unrelated spaces/grants/users/content/files are untouched');
  assert.equal(roles.canReadSpace(member, privateSpace), false);
  assert.equal(roles.canReadSpace(member, data.getSpace(publicSpace.id)), false, 'unrelated tenant still denied');
  assert.equal(roles.canEditSpace(member, groupSpace.id), true, 'existing group access preserved');
  assert.equal(roles.canEditSpace(member, capped.id), false, 'space-local agent ceiling preserved');
  assert.equal(verifyChain().ok, true);
  assert.equal(fetches, 0, 'remote references/request panels never execute during import');
  assert.equal(db.inTransaction, false);
  console.log('PASS OpenAPI import: real action/page guards, JSON/YAML ownership and access, reference fidelity, local audit, page/member/audit/commit rollback, unrelated-data preservation, and post-commit failures.');
} finally {
  db?.close();
  Module._load = originalLoad;
  if (originalTs) Module._extensions['.ts'] = originalTs; else delete Module._extensions['.ts'];
  if (originalTsx) Module._extensions['.tsx'] = originalTsx; else delete Module._extensions['.tsx'];
  globalThis.fetch = originalFetch; console.error = originalError;
  fs.rmSync(temporary, { recursive: true, force: true });
}
