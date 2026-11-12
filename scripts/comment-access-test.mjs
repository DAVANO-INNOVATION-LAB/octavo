// Actual actions/routes, sessions, SQLite, authorization and notifications.
// Only framework/client boundaries and outbound fetch are isolated.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url), root = path.resolve('src');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-comment-access-'));
process.env.OCTAVO_DATA_DIR = temporary;
const originalLoad = Module._load, originalTs = Module._extensions['.ts'], originalTsx = Module._extensions['.tsx'];
const originalFetch = globalThis.fetch;
let cookie, db, checks = 0;
const invalidated = [], fetches = [];
class Signal extends Error { constructor(kind, location) { super(kind); this.kind = kind; this.location = location; } }
Module._load = function(name, parent, main) {
  if (name === 'server-only') return {};
  if (name === 'next/navigation') return {
    redirect: location => { throw new Signal('redirect', location); },
    notFound: () => { throw new Signal('notFound'); },
  };
  if (name === 'next/cache') return { revalidatePath: value => invalidated.push(value) };
  if (name === 'next/headers') return {
    cookies: async () => ({ get: name => name === 'octavo_session' && cookie ? { value: cookie } : undefined }),
    headers: async () => new Map(),
  };
  if (name.startsWith('@/components/')) return new Proxy({}, { get: (_, key) => key === '__esModule' ? true : function ClientBoundary() {} });
  if (name.startsWith('@/')) name = path.join(root, name.slice(2));
  return originalLoad.call(this, name, parent, main);
};
Module._extensions['.ts'] = Module._extensions['.tsx'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText, file);
globalThis.fetch = async (url, options) => {
  assert.equal(url, 'https://synthetic.invalid/comment', 'Unexpected outbound request');
  fetches.push(JSON.parse(options.body));
  return { ok: true };
};
const load = name => require(path.join(root, name));
const call = async invoke => { try { return { value: await invoke() }; } catch (error) { if (!(error instanceof Signal)) throw error; return { signal: error.kind, location: error.location }; } };
const form = values => { const f = new FormData(); for (const [key, value] of Object.entries(values)) f.set(key, String(value)); return f; };
const wire = value => JSON.stringify(value, (key, v) => (key === 'type' && typeof v !== 'string') || key === '_owner' || typeof v === 'function' ? undefined : v);
try {
  db = load('lib/db.ts').getDb();
  const data = load('lib/data.ts'), roles = load('lib/roles.ts'), tenants = load('lib/tenants.ts'), groups = load('lib/groups.ts');
  const auth = load('lib/auth.ts'), settings = load('lib/settings.ts'), actions = load('app/actions.ts');
  const actors = {};
  for (const name of ['author', 'reader', 'editor', 'spaceAdmin', 'admin', 'outsider', 'crossDirect', 'crossGroup', 'instanceAgent', 'directAgent', 'groupAgent']) {
    const role = name === 'admin' ? 'admin' : name === 'instanceAgent' ? 'agent' : 'member';
    actors[name] = { id: name, email: `${name}@example.test`, name, role };
    db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(name, actors[name].email, name, '!', role, Date.now());
    db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run(`synthetic-${name}`, name, Date.now() + 86400000);
  }
  const login = async actor => { cookie = actor ? `synthetic-${actor.id}` : undefined; assert.equal((await auth.currentUser())?.id, actor?.id); };
  const tenant = tenants.createTenant('Comment tenant'), otherTenant = tenants.createTenant('Other comment tenant');
  for (const name of ['crossDirect', 'crossGroup']) tenants.addMember(otherTenant.id, name);
  for (const name of ['author', 'reader', 'editor', 'spaceAdmin', 'instanceAgent', 'directAgent', 'groupAgent']) tenants.addMember(tenant.id, name);
  const agentGroup = groups.createGroup('Comment agents'), excludedGroup = groups.createGroup('Retained outsider group');
  groups.addGroupMember(agentGroup.id, 'groupAgent'); groups.addGroupMember(excludedGroup.id, 'crossGroup');
  const fixtures = [];
  for (const tenanted of [false, true]) for (const visibility of ['private', 'public']) {
    let space = data.createSpace({ name: `Comment ${tenanted ? 'tenant' : 'library'} ${visibility}`, visibility });
    if (tenanted) tenants.setSpaceTenant(space.id, tenant.id);
    for (const [name, role] of Object.entries({ author: 'editor', reader: 'reader', editor: 'editor', spaceAdmin: 'admin', crossDirect: 'admin', instanceAgent: 'admin', directAgent: 'agent' })) roles.setSpaceMember(space.id, name, role);
    groups.setGroupGrant(agentGroup.id, space.id, 'agent'); groups.setGroupGrant(excludedGroup.id, space.id, 'admin');
    space = data.getSpace(space.id);
    for (const published of [false, true]) fixtures.push({ space, page: data.createPage({ spaceId: space.id, title: `PAGE_${space.slug}_${published}`, published }), tenanted });
  }
  settings.setSetting('webhook_url', 'https://synthetic.invalid/comment');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const queries = tables.map(table => [table, db.prepare(`SELECT * FROM "${table}"`)]);
  const snapshot = () => Object.fromEntries(queries.map(([table, query]) => [table, wire(query.all().sort((a, b) => wire(a).localeCompare(wire(b))))]));
  const effects = () => ({ tables: snapshot(), cache: [...invalidated], outbound: [...fetches] });
  const deny = async (label, invoke) => {
    const before = effects(), result = await call(invoke);
    assert.ok(result.signal, `${label}: denial`); assert.deepEqual(effects(), before, `${label}: all DB/cache/webhook effects unchanged`); checks++;
    return result;
  };
  const input = (f, extra = {}) => form({ pageId: f.page.id, space: 'untrusted-space', page: 'untrusted-page', ...extra });
  const readable = (f, actor) => {
    if (actor?.id === 'admin') return true;
    if (f.tenanted && (!actor || ['outsider', 'crossDirect', 'crossGroup'].includes(actor.id))) return false;
    return f.space.visibility === 'public' || (!!actor && actor.id !== 'outsider');
  };
  const writable = (f, actor) => readable(f, actor) && !!actor && (['admin', 'author', 'editor', 'spaceAdmin'].includes(actor.id) || (!f.tenanted && ['crossDirect', 'crossGroup'].includes(actor.id)));
  const visible = (f, actor) => readable(f, actor) && (f.page.published === 1 || writable(f, actor));
  const commenter = (f, actor) => !!actor && visible(f, actor) && !['instanceAgent', 'directAgent', 'groupAgent'].includes(actor.id);
  const admin = (f, actor) => commenter(f, actor) && (['admin', 'spaceAdmin'].includes(actor.id) || (!f.tenanted && ['crossDirect', 'crossGroup'].includes(actor.id)));
  for (const f of fixtures) for (const actor of [null, ...Object.values(actors)]) {
    await login(actor);
    const url = `/${f.space.slug}/${f.page.slug}`;
    const add = () => actions.addCommentAction(input(f, { body: '  NEW_COMMENT  ' }));
    if (!commenter(f, actor)) await deny('add denied', add);
    else {
      const before = data.listComments(f.page.id).length, result = await call(add);
      const created = data.listComments(f.page.id).at(-1);
      assert.equal(data.listComments(f.page.id).length, before + 1); assert.equal(created.body, 'NEW_COMMENT');
      assert.equal(result.location, `${url}#t-${created.id}`); assert.equal(invalidated.at(-1), url); checks++;
    }
    for (const operation of ['delete', 'resolve']) for (const own of [false, true]) {
      const owner = own && actor ? actor.id : 'author';
      const id = data.addComment(f.page.id, owner, `TARGET_${operation}`);
      const reply = data.addComment(f.page.id, 'reader', 'REPLY', { parentId: id });
      const invoke = () => operation === 'delete' ? actions.deleteCommentAction(input(f, { id })) : actions.setThreadResolvedAction(input(f, { id, resolved: '1' }));
      const allowed = commenter(f, actor) && (owner === actor.id || admin(f, actor));
      if (!allowed) await deny(`${operation} denied`, invoke);
      else {
        const beforeNotifications = wire(db.prepare('SELECT * FROM notifications').all());
        const result = await call(invoke);
        if (operation === 'delete') { assert.equal(data.getComment(id), null); assert.equal(data.getComment(reply), null); assert.equal(result.location, `${url}#discussion`); }
        else { assert.equal(db.prepare('SELECT resolved FROM comments WHERE id=?').get(id).resolved, 1); assert.equal(result.location, `${url}#t-${id}`); }
        assert.equal(wire(db.prepare('SELECT * FROM notifications').all()), beforeNotifications); assert.equal(invalidated.at(-1), url); checks++;
      }
    }
  }
  // An administrator for one page cannot borrow that authority for another.
  const owned = fixtures[1], foreign = fixtures[5];
  roles.setSpaceMember(owned.space.id, 'outsider', 'admin'); await login(actors.outsider);
  const foreignRoot = data.addComment(foreign.page.id, 'author', 'PRIVATE_ROOT');
  for (const pageId of [owned.page.id, 'missing-page', '', foreign.page.id]) {
    await deny('foreign resolve', () => actions.setThreadResolvedAction(input(foreign, { id: foreignRoot, pageId, resolved: '1' })));
    await deny('foreign delete', () => actions.deleteCommentAction(input(foreign, { id: foreignRoot, pageId })));
  }
  roles.removeSpaceMember(owned.space.id, 'outsider');
  // No comment means no mention/reply notification, cache invalidation or audit.
  await login(actors.author);
  for (const body of ['', '   ']) await deny('empty comment', () => actions.addCommentAction(input(owned, { body })));
  for (const parentId of ['missing-comment', foreignRoot]) await deny('invalid parent', () => actions.addCommentAction(input(owned, { body: '@reader SHOULD_NOT_SEND', parentId })));
  for (const id of ['', 'missing-comment']) {
    await deny('missing delete', () => actions.deleteCommentAction(input(owned, { id })));
    await deny('missing resolve', () => actions.setThreadResolvedAction(input(owned, { id, resolved: '1' })));
  }
  const ownRoot = data.addComment(owned.page.id, 'author', 'ROOT');
  const ownReply = data.addComment(owned.page.id, 'reader', 'REPLY', { parentId: ownRoot });
  await login(actors.spaceAdmin);
  await deny('reply cannot resolve', () => actions.setThreadResolvedAction(input(owned, { id: ownReply, resolved: '1' })));
  // Replying to a reply uses the persisted root, including notification URL.
  const beforeRootNotify = db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=?').get('author').n;
  const replyResult = await call(() => actions.addCommentAction(input(owned, { body: 'REPLY_TO_REPLY', parentId: ownReply })));
  assert.equal(replyResult.location, `/${owned.space.slug}/${owned.page.slug}#t-${ownRoot}`);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=?').get('author').n, beforeRootNotify + 1);
  const lastReply = data.listComments(owned.page.id).at(-1); assert.equal(lastReply.parent_id, ownRoot); checks++;
  // Corrupt legacy roots do not bind a reply to another page or an absent root.
  const malformed = data.addComment(owned.page.id, 'author', 'BAD_PARENT');
  for (const parentId of [foreignRoot, 'missing-root', ownReply]) {
    db.prepare('UPDATE comments SET parent_id=? WHERE id=?').run(parentId, malformed);
    await deny('invalid root chain', () => actions.addCommentAction(input(owned, { body: '@reader PRIVATE', parentId: malformed })));
  }
  db.prepare('UPDATE comments SET parent_id=NULL WHERE id=?').run(malformed);
  // New mention and reply copies only go to principals who can currently view
  // the page. Existing notifications and comment history remain untouched.
  for (const f of fixtures) {
    await login(actors.spaceAdmin);
    const before = db.prepare('SELECT COUNT(*) n FROM notifications').get().n;
    const body = Object.keys(actors).map(name => `@${name}`).join(' ') + ' PRIVATE_COMMENT';
    await call(() => actions.addCommentAction(input(f, { body })));
    const delivered = db.prepare('SELECT * FROM notifications ORDER BY rowid').all().slice(before);
    assert.deepEqual(delivered.map(n => n.user_id).sort(), Object.values(actors).filter(a => a.id !== 'spaceAdmin' && visible(f, a)).map(a => a.id).sort());
    assert.ok(delivered.every(n => n.url.startsWith(`/${f.space.slug}/${f.page.slug}#t-`))); checks++;
  }
  // Author loses membership: authorship permits neither mutation nor fresh reply copy.
  const revoked = data.createSpace({ name: 'Revoked comments', visibility: 'private' });
  const revokedPage = data.createPage({ spaceId: revoked.id, title: 'Revoked page', published: true });
  roles.setSpaceMember(revoked.id, 'spaceAdmin', 'admin'); roles.setSpaceMember(revoked.id, 'outsider', 'reader');
  const revokedRoot = data.addComment(revokedPage.id, 'outsider', 'HISTORICAL_COMMENT');
  const revokedFixture = { space: revoked, page: revokedPage };
  db.prepare('INSERT INTO notifications(id,user_id,kind,actor_name,title,body,url,space_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('historical', 'outsider', 'reply', 'old', 'old title', 'old body', '/old', revoked.id, 1);
  roles.removeSpaceMember(revoked.id, 'outsider'); await login(actors.outsider);
  await deny('revoked author delete', () => actions.deleteCommentAction(input(revokedFixture, { id: revokedRoot })));
  await deny('revoked author resolve', () => actions.setThreadResolvedAction(input(revokedFixture, { id: revokedRoot, resolved: '1' })));
  await login(actors.spaceAdmin);
  const beforeRevoked = wire(db.prepare('SELECT * FROM notifications WHERE user_id=?').all('outsider'));
  await call(() => actions.addCommentAction(input(revokedFixture, { body: '@outsider NEW_PRIVATE', parentId: revokedRoot })));
  assert.equal(wire(db.prepare('SELECT * FROM notifications WHERE user_id=?').all('outsider')), beforeRevoked);
  assert.equal(data.getComment(revokedRoot).body, 'HISTORICAL_COMMENT'); checks++;
  // Deactivated recipients and missing users are never fresh disclosure targets.
  const beforeDeactivated = wire(db.prepare('SELECT * FROM notifications WHERE user_id=?').all('reader'));
  const dormantRoot = data.addComment(owned.page.id, 'reader', 'OLD_READER_ROOT');
  db.prepare('UPDATE users SET active=0 WHERE id=?').run('reader');
  await call(() => actions.addCommentAction(input(owned, { body: '@reader DORMANT_PRIVATE', parentId: dormantRoot })));
  assert.equal(wire(db.prepare('SELECT * FROM notifications WHERE user_id=?').all('reader')), beforeDeactivated);
  db.prepare('UPDATE users SET active=1 WHERE id=?').run('reader'); checks++;
  // Missing persisted page/space cannot borrow rights from the submitted IDs.
  const missingSpace = data.createSpace({ name: 'Missing comment space', visibility: 'public' });
  const missingSpacePage = data.createPage({ spaceId: missingSpace.id, title: 'Missing actual space', published: true });
  const missingSpaceRoot = data.addComment(missingSpacePage.id, 'author', 'ORPHAN_SPACE');
  db.pragma('foreign_keys=OFF'); db.prepare('DELETE FROM spaces WHERE id=?').run(missingSpace.id); db.pragma('foreign_keys=ON');
  const missingPageSpace = data.createSpace({ name: 'Missing comment page', visibility: 'public' });
  const missingPage = data.createPage({ spaceId: missingPageSpace.id, title: 'Missing actual page', published: true });
  const missingPageRoot = data.addComment(missingPage.id, 'author', 'ORPHAN_PAGE');
  db.pragma('foreign_keys=OFF'); db.prepare('DELETE FROM pages WHERE id=?').run(missingPage.id); db.pragma('foreign_keys=ON');
  await login(actors.admin);
  for (const [pageId, id] of [[missingSpacePage.id, missingSpaceRoot], [missingPage.id, missingPageRoot]]) {
    await deny('missing persisted add', () => actions.addCommentAction(form({ pageId, body: '@reader ORPHAN' })));
    await deny('missing persisted delete', () => actions.deleteCommentAction(form({ pageId, id })));
    await deny('missing persisted resolve', () => actions.setThreadResolvedAction(form({ pageId, id, resolved: '1' })));
  }
  await login(actors.spaceAdmin);
  // Mentions after the stored truncation boundary cannot trigger delivery.
  const beforeTruncated = db.prepare('SELECT COUNT(*) n FROM notifications').get().n;
  await call(() => actions.addCommentAction(input(owned, { body: 'x'.repeat(4000) + ' @reader' })));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications').get().n, beforeTruncated); checks++;
  // Missing/soft-deleted target is denied even to the instance administrator.
  for (const f of fixtures) {
    const rootComment = data.addComment(f.page.id, 'author', 'DELETED_TARGET');
    data.deleteSpace(f.space.id, 'admin'); await login(actors.admin);
    await deny('deleted add', () => actions.addCommentAction(input(f, { body: '@reader DELETED' })));
    await deny('deleted resolve', () => actions.setThreadResolvedAction(input(f, { id: rootComment, resolved: '1' })));
    await deny('deleted delete', () => actions.deleteCommentAction(input(f, { id: rootComment })));
  }
  await deny('missing page add', () => actions.addCommentAction(form({ pageId: 'missing-page', body: 'COMMENT' })));
  console.log(`PASS comment access: ${checks} real session/action/SQLite checks; rejected calls leave every database table, cache and webhook unchanged; zero external requests.`);
} finally {
  if (db?.open) db.close();
  Module._load = originalLoad;
  if (originalTs) Module._extensions['.ts'] = originalTs; else delete Module._extensions['.ts'];
  if (originalTsx) Module._extensions['.tsx'] = originalTsx; else delete Module._extensions['.tsx'];
  globalThis.fetch = originalFetch;
  fs.rmSync(temporary, { recursive: true, force: true });
}
