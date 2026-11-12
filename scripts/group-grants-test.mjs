// Real group/direct/instance grant resolution and route/actions on disposable SQLite.
// No live server or user data. Framework navigation/cache/auth and audit forwarding are boundaries.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url), root = path.resolve('src');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-group-grants-'));
process.env.OCTAVO_DATA_DIR = temporary;
const originalLoad = Module._load, originalTs = Module._extensions['.ts'];
const originalFetch = globalThis.fetch;
let user, db, fetches = 0, checks = 0;
const invalidated = [], forwarded = [];
class Redirect extends Error { constructor(location) { super(location); this.location = location; } }
Module._load = function(name, parent, main) {
  if (name === 'server-only') return {};
  if (name === 'next/navigation') return { redirect: location => { throw new Redirect(location); } };
  if (name === 'next/cache') return { revalidatePath: value => invalidated.push(value) };
  if (name === 'next/headers') return { cookies: async () => ({ get: () => undefined }), headers: async () => new Map() };
  if (name === '@/lib/auth') return { currentUser: async () => user };
  if (name === './audit-forward') return { forwardAudit: entry => forwarded.push(entry) };
  if (name.startsWith('@/')) name = path.join(root, name.slice(2));
  return originalLoad.call(this, name, parent, main);
};
Module._extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, file);
globalThis.fetch = () => { fetches++; throw new Error('Unexpected external request'); };
const load = name => require(path.join(root, name));
const form = values => { const result = new FormData(); for (const [key, value] of Object.entries(values)) result.set(key, value); return result; };
const redirected = async invoke => {
  try { await invoke(); assert.fail('Expected navigation'); }
  catch (error) { if (!(error instanceof Redirect)) throw error; return error.location; }
};
const allCaps = ['read', 'comment', 'propose', 'write', 'publish', 'merge', 'administer'];
// Explicit expectations, independent of the production role resolver.
const expectedFor = (instance, direct, grants, accessible, visibility) => {
  if (!accessible || (!direct && !grants.length && visibility === 'private' && instance !== 'admin')) return [];
  if (instance === 'agent' || direct === 'agent') return ['read', 'propose'];
  if (instance === 'admin' || direct === 'admin' || grants.includes('admin')) return allCaps;
  if (direct === 'editor' || grants.includes('editor')) return allCaps.slice(0, -1);
  if (direct === 'reader' || grants.includes('reader') || !grants.length) return allCaps.slice(0, 3);
  return ['read', 'propose'];
};
try {
  db = load('lib/db.ts').getDb();
  const data = load('lib/data.ts'), roles = load('lib/roles.ts'), groups = load('lib/groups.ts'), tenants = load('lib/tenants.ts');
  // Initialize the existing lazy SCIM schema before immutable grant snapshots.
  load('lib/scim.ts').isDeactivated('__synthetic_missing__');
  const actions = load('app/actions.ts');
  const comments = load('app/api/comments/route.ts').POST;
  const patch = load('app/api/pages/[id]/route.ts').PATCH;
  user = { id: 'actor', email: 'actor@example.test', name: 'Synthetic actor', role: 'member' };
  db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(user.id, user.email, user.name, '!', user.role, Date.now());
  const tenant = tenants.createTenant('Synthetic group tenant');
  const fixtures = [];
  for (const tenanted of [false, true]) for (const visibility of ['private', 'public']) {
    let space = data.createSpace({ name: `Group ${tenanted ? 'tenant' : 'library'} ${visibility}`, visibility });
    if (tenanted) tenants.setSpaceTenant(space.id, tenant.id);
    space = data.getSpace(space.id);
    const page = data.createPage({ spaceId: space.id, title: 'Original group page', published: true });
    fixtures.push({ space, page, tenanted });
  }
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  // Reuse statements across the large matrix instead of accumulating native statement handles.
  const snapshots = tables.map(table => [table, db.prepare(`SELECT * FROM "${table}"`)]);
  const grantQueries = ['users', 'groups', 'group_members', 'group_space_roles', 'space_members', 'tenant_members'].map(table => db.prepare(`SELECT * FROM ${table}`));
  const snapshot = () => JSON.stringify(snapshots.map(([table, query]) => [table, query.all()]));
  const grantsSnapshot = () => JSON.stringify(grantQueries.map(query => query.all()));
  const action = async (label, allowed, invoke, verify) => {
    const before = allowed ? null : snapshot(), cacheBefore = invalidated.length, forwardBefore = forwarded.length;
    const result = await invoke();
    verify(result);
    if (!allowed) {
      assert.equal(snapshot(), before, `${label}: denied operation leaves every table and audit unchanged`);
      assert.equal(invalidated.length, cacheBefore, `${label}: denied operation invalidates no cache`);
      assert.equal(forwarded.length, forwardBefore, `${label}: denied operation forwards no audit`);
    }
    checks++;
  };
  const combinations = [[], ['agent'], ['agent', 'agent'], ['reader'], ['editor'], ['admin'],
    ['agent', 'reader'], ['reader', 'agent'], ['agent', 'editor'], ['editor', 'agent'], ['agent', 'admin'], ['admin', 'agent'],
    ['agent', 'reader', 'editor', 'admin'], ['admin', 'editor', 'reader', 'agent']];
  let cases = 0;
  for (const { space, page, tenanted } of fixtures) for (const memberOfTenant of tenanted ? [true, false] : [true]) {
    for (const instance of ['member', 'agent', 'admin']) for (const direct of [null, 'agent', 'reader', 'editor', 'admin']) for (const grants of combinations) {
      const label = `${space.slug}/tenant=${memberOfTenant}/${instance}/direct=${direct}/groups=${grants.join(',')}`;
      db.exec('SAVEPOINT fixture');
      try {
        user.role = instance;
        db.prepare('UPDATE users SET role = ? WHERE id = ?').run(instance, user.id);
        if (memberOfTenant) tenants.addMember(tenant.id, user.id);
        if (direct) roles.setSpaceMember(space.id, user.id, direct);
        for (const [index, grant] of grants.entries()) {
          // Insert each combination in its stated order, including duplicate-agent groups.
          const group = groups.createGroup(`Grant ${index} ${grant}`);
          groups.addGroupMember(group.id, user.id);
          groups.setGroupGrant(group.id, space.id, grant);
        }
        const originalGrants = grantsSnapshot();
        const accessible = !tenanted || memberOfTenant || instance === 'admin';
        const expected = expectedFor(instance, direct, grants, accessible, space.visibility);
        const groupExpected = ['admin', 'editor', 'reader', 'agent'].find(role => grants.includes(role)) ?? null;
        assert.equal(groups.groupRoleFor(user.id, space.id), groupExpected, `${label}: group union`);
        assert.deepEqual(roles.capsFor(user, space.id), expected, `${label}: capability union`);
        assert.equal(roles.canReadSpace(user, space), accessible && (space.visibility === 'public' || instance === 'admin' || !!direct || !!grants.length), `${label}: readable`);
        for (const capability of allCaps) assert.equal(roles.may(user, space.id, capability), expected.includes(capability), `${label}: ${capability}`);
        assert.equal(roles.canEditSpace(user, space.id), expected.includes('write'));
        assert.equal(roles.canAdminSpace(user, space.id), expected.includes('administer'));
        assert.deepEqual(roles.capsFor(user, 'missing-space'), []);
        assert.equal(roles.canRestoreSpace(user, 'missing-space'), false);
        checks++;
        await action(`${label}: propose`, expected.includes('propose'), () => redirected(() => actions.createChangeRequestAction(form({
          pageId: page.id, space: space.slug, title: 'Synthetic proposal', proposedTitle: 'Proposed title', proposedContent: '[]',
        }))), location => {
          const proposals = db.prepare('SELECT * FROM change_requests WHERE page_id = ?').all(page.id);
          assert.equal(proposals.length, expected.includes('propose') ? 1 : 0);
          if (expected.includes('propose')) { assert.equal(proposals[0].author_id, user.id); assert.match(location, /\/changes\//); }
          else assert.equal(location, "/");
          assert.equal(data.getPage(page.id).title, page.title, 'proposal never changes page');
        });
        await action(`${label}: comment`, expected.includes('comment'), () => comments(new Request('http://localhost/api/comments', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pageId: page.id, body: 'Synthetic comment' }),
        })), response => {
          assert.equal(response.status, expected.includes('comment') ? 200 : 403);
          assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments WHERE page_id = ?').get(page.id).n, expected.includes('comment') ? 1 : 0);
        });
        await action(`${label}: patch`, expected.includes('write'), () => patch(new Request('http://localhost/api/pages/fixture', {
          method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Written title' }),
        }), { params: Promise.resolve({ id: page.id }) }), response => {
          assert.equal(response.status, expected.includes('write') ? 200 : 403);
          assert.equal(data.getPage(page.id).title, expected.includes('write') ? 'Written title' : page.title);
        });
        await action(`${label}: settings`, expected.includes('administer'), () => redirected(() => actions.updateSpaceAction(form({
          slug: space.slug, name: 'Changed group space', description: 'Synthetic change',
        }))), location => {
          assert.equal(location, expected.includes('administer') ? `/${space.slug}` : '/');
          assert.equal(data.getSpace(space.id).name, expected.includes('administer') ? 'Changed group space' : space.name);
        });
        assert.equal(grantsSnapshot(), originalGrants, `${label}: resolution/actions never rewrite grants`);
        // Recovery deliberately crosses the deleted-space gate, but no tenant/agent boundary.
        data.deleteSpace(space.id, user.id);
        assert.deepEqual(roles.capsFor(user, space.id), []);
        assert.equal(roles.canReadSpace(user, space), false);
        const restorable = accessible && instance !== 'agent' && direct !== 'agent' && (instance === 'admin' || direct === 'admin' || grants.includes('admin'));
        assert.equal(roles.canRestoreSpace(user, space.id), restorable, `${label}: retained recovery grants`);
        await action(`${label}: deleted comment`, false, () => comments(new Request('http://localhost/api/comments', {
          method: 'POST', body: JSON.stringify({ pageId: page.id, body: 'Denied deleted comment' }),
        })), response => assert.equal(response.status, 404));
        await action(`${label}: deleted patch`, false, () => patch(new Request('http://localhost/api/pages/fixture', {
          method: 'PATCH', body: JSON.stringify({ title: 'Denied deleted title' }),
        }), { params: Promise.resolve({ id: page.id }) }), response => assert.equal(response.status, 404));
        await action(`${label}: deleted propose`, false, () => redirected(() => actions.createChangeRequestAction(form({
          pageId: page.id, space: space.slug, title: 'Denied deleted proposal',
        }))), location => assert.equal(location, '/'));
        await action(`${label}: deleted settings`, false, () => redirected(() => actions.updateSpaceAction(form({
          slug: space.slug, name: 'Denied deleted settings',
        }))), location => assert.equal(location, '/'));
        await action(`${label}: restore`, restorable, () => redirected(() => actions.restoreSpaceAction(form({ spaceId: space.id }))), () => {
          assert.equal(roles.isSpaceDeleted(space.id), !restorable);
        });
        assert.equal(grantsSnapshot(), originalGrants, `${label}: recovery never rewrites grants`);
        cases++;
      } finally { db.exec('ROLLBACK TO fixture; RELEASE fixture'); }
    }
  }
  // Revocation is reflected on the next request; public fallback is not a retained group grant.
  user.role = 'member';
  const group = groups.createGroup('Revocable agent group');
  groups.addGroupMember(group.id, user.id);
  for (const { space, tenanted } of fixtures.filter(item => !item.tenanted)) {
    assert.equal(tenanted, false);
    groups.setGroupGrant(group.id, space.id, 'agent');
    assert.deepEqual(roles.capsFor(user, space.id), ['read', 'propose']);
    groups.setGroupGrant(group.id, space.id, null);
    assert.deepEqual(roles.capsFor(user, space.id), space.visibility === 'private' ? [] : allCaps.slice(0, 3));
    groups.setGroupGrant(group.id, space.id, 'agent');
  }
  groups.removeGroupMember(group.id, user.id);
  for (const { space } of fixtures.filter(item => !item.tenanted)) assert.deepEqual(roles.capsFor(user, space.id), space.visibility === 'private' ? [] : allCaps.slice(0, 3));
  user = null;
  for (const { space } of fixtures) assert.deepEqual(roles.capsFor(user, space.id), []);
  assert.equal((await comments(new Request('http://localhost/api/comments', { method: 'POST' }))).status, 401);
  assert.equal((await patch(new Request('http://localhost/api/pages/missing', { method: 'PATCH' }), { params: Promise.resolve({ id: 'missing' }) })).status, 401);
  assert.equal(require(path.join(root, 'lib/audit.ts')).verifyChain().ok, true);
  assert.equal(fetches, 0);
  console.log(`PASS group grants: ${cases} role/visibility/tenant/order cases, ${checks} matrix and real-action checks; proposal/comment/PATCH/settings, deleted recovery, revocation, no denied writes or external requests.`);
} finally {
  db?.close();
  Module._load = originalLoad;
  if (originalTs) Module._extensions['.ts'] = originalTs; else delete Module._extensions['.ts'];
  globalThis.fetch = originalFetch;
  fs.rmSync(temporary, { recursive: true, force: true });
}
