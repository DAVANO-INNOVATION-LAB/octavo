// Actual actions/routes, sessions, SQLite, authorization and notifications.
// Only framework/client boundaries and outbound fetch are isolated.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url), root = path.resolve('src');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-cr-access-'));
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
  assert.equal(url, 'https://synthetic.invalid/review', 'Unexpected outbound request');
  fetches.push(JSON.parse(options.body));
  return { ok: true };
};
const load = name => require(path.join(root, name));
const call = async invoke => { try { return { value: await invoke() }; } catch (error) { if (!(error instanceof Signal)) throw error; return { signal: error.kind, location: error.location }; } };
const form = values => { const f = new FormData(); for (const [key, value] of Object.entries(values)) f.set(key, String(value)); return f; };
const wire = value => JSON.stringify(value, (key, v) => (key === 'type' && typeof v !== 'string') || key === '_owner' || typeof v === 'function' ? undefined : v);
const content = marker => JSON.stringify([{ id: marker, type: 'paragraph', content: [{ type: 'text', text: marker, styles: {} }], children: [] }]);
try {
  db = load('lib/db.ts').getDb();
  const data = load('lib/data.ts'), roles = load('lib/roles.ts'), tenants = load('lib/tenants.ts'), groups = load('lib/groups.ts');
  const auth = load('lib/auth.ts'), crs = load('lib/change-requests.ts'), settings = load('lib/settings.ts');
  const actions = load('app/actions.ts');
  const createApi = load('app/api/change-requests/route.ts').POST;
  const detail = load('app/[space]/[page]/changes/[cr]/page.tsx').default;
  const inbox = load('app/inbox/page.tsx').default;
  const proposal = load('app/[space]/[page]/propose/page.tsx').default;
  const list = load('app/[space]/[page]/changes/page.tsx').default;
  const actors = {};
  for (const name of ['author', 'reader', 'editor', 'spaceAdmin', 'admin', 'outsider', 'crossDirect', 'crossGroup', 'instanceAgent', 'directAgent', 'groupAgent']) {
    const role = name === 'admin' ? 'admin' : name === 'instanceAgent' ? 'agent' : 'member';
    actors[name] = { id: name, email: `${name}@example.test`, name, role };
    db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(name, actors[name].email, name, '!', role, Date.now());
    db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run(`synthetic-${name}`, name, Date.now() + 86400000);
  }
  const login = async actor => { cookie = actor ? `synthetic-${actor.id}` : undefined; assert.equal((await auth.currentUser())?.id, actor?.id); };
  const tenant = tenants.createTenant('Review tenant'), otherTenant = tenants.createTenant('Other review tenant');
  for (const name of ['crossDirect', 'crossGroup']) tenants.addMember(otherTenant.id, name);
  for (const name of ['author', 'reader', 'editor', 'spaceAdmin', 'instanceAgent', 'directAgent', 'groupAgent']) tenants.addMember(tenant.id, name);
  const agentGroup = groups.createGroup('Agent reviewers'), excludedGroup = groups.createGroup('Retained cross-tenant grant');
  groups.addGroupMember(agentGroup.id, 'groupAgent'); groups.addGroupMember(excludedGroup.id, 'crossGroup');
  const fixtures = [];
  for (const tenanted of [false, true]) for (const visibility of ['private', 'public']) {
    let space = data.createSpace({ name: `Review ${tenanted ? 'tenant' : 'library'} ${visibility}`, visibility });
    if (tenanted) tenants.setSpaceTenant(space.id, tenant.id);
    for (const [name, role] of Object.entries({ author: 'admin', reader: 'reader', editor: 'editor', spaceAdmin: 'admin', crossDirect: 'admin', instanceAgent: 'admin', directAgent: 'agent' })) roles.setSpaceMember(space.id, name, role);
    groups.setGroupGrant(agentGroup.id, space.id, 'agent'); groups.setGroupGrant(excludedGroup.id, space.id, 'admin');
    space = data.getSpace(space.id);
    for (const published of [false, true]) {
      const marker = `${space.slug}-${published ? 'published' : 'draft'}`;
      const page = data.createPage({ spaceId: space.id, title: `PAGE_${marker}`, published, content: content(`BODY_${marker}`) });
      fixtures.push({ space, page, marker, tenanted });
    }
  }
  const decoySpace = data.createSpace({ name: 'Public decoy', visibility: 'public' });
  const decoyPage = data.createPage({ spaceId: decoySpace.id, title: 'Decoy page', published: true });
  settings.setSetting('webhook_url', 'https://synthetic.invalid/review');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const queries = tables.map(table => [table, db.prepare(`SELECT * FROM "${table}"`)]);
  const snapshot = () => Object.fromEntries(queries.map(([table, query]) => [table, wire(query.all().sort((a, b) => wire(a).localeCompare(wire(b))))]));
  const effectSnapshot = () => ({ tables: snapshot(), cache: [...invalidated], outbound: [...fetches] });
  const deny = async (label, invoke) => {
    const before = effectSnapshot(), result = await call(invoke);
    assert.ok(result.signal, `${label}: must deny`); assert.deepEqual(effectSnapshot(), before, `${label}: every table/audit/notification/cache/webhook unchanged`); checks++;
    return result;
  };
  const newCr = (f, author = 'author') => {
    const cr = crs.createChangeRequest({ pageId: f.page.id, authorId: author, title: `CR_${f.marker}`, description: `DESCRIPTION_${f.marker}`, proposedTitle: `PROPOSED_TITLE_${f.marker}`, proposedContent: content(`PROPOSED_BODY_${f.marker}`) });
    db.prepare('UPDATE change_requests SET updated_at=1 WHERE id=?').run(cr.id);
    return cr;
  };
  const input = (f, cr, extra = {}) => form({ id: cr.id, space: 'untrusted-space', page: 'untrusted-page', ...extra });
  const routeInput = (f, cr, extra = {}) => ({ params: Promise.resolve({ space: f.space.slug, page: f.page.slug, cr: cr.id, ...extra }), searchParams: Promise.resolve({}) });
  // Explicit fixture oracle, independent of the production permission helpers.
  const readable = (f, actor) => {
    if (actor?.id === 'admin') return true;
    if (f.tenanted && (!actor || ['outsider', 'crossDirect', 'crossGroup'].includes(actor.id))) return false;
    return f.space.visibility === 'public' || (!!actor && actor.id !== 'outsider');
  };
  const writable = (f, actor) => readable(f, actor) && !!actor && (['admin', 'author', 'editor', 'spaceAdmin'].includes(actor.id) || (!f.tenanted && ['crossDirect', 'crossGroup'].includes(actor.id)));
  const visible = (f, actor) => readable(f, actor) && (f.page.published === 1 || writable(f, actor));
  for (const f of fixtures) for (const actor of [null, ...Object.values(actors)]) {
    await login(actor);
    const read = readable(f, actor);
    assert.equal(roles.canReadSpace(actor, f.space), read);
    const cr = newCr(f), url = `/${f.space.slug}/${f.page.slug}/changes/${cr.id}`;
    for (const verdict of ['approve', 'changes', 'approve']) {
      const invoke = () => actions.reviewChangeRequestAction(input(f, cr, { verdict, note: `REVIEW_${f.marker}` }));
      if (!actor || actor.id === 'author' || !visible(f, actor)) {
        const result = await deny(`${f.marker}/${actor?.id}/${verdict}`, invoke);
        assert.equal(result.location, !actor ? '/login' : !visible(f, actor) ? '/' : `${url}?error=self`);
        assert.equal(crs.listReviews(cr.id).length, 0);
      } else {
        const before = snapshot(), cache = invalidated.length, outbound = fetches.length;
        assert.equal((await call(invoke)).location, url);
        const after = snapshot();
        assert.deepEqual(tables.filter(table => before[table] !== after[table]), ['change_requests', 'cr_reviews', 'notifications']);
        assert.equal(crs.listReviews(cr.id).length, 1); assert.equal(crs.listReviews(cr.id)[0].verdict, verdict);
        assert.equal(crs.mergeCheck(crs.getChangeRequest(cr.id)).changesRequested, verdict === 'changes' ? 1 : 0);
        assert.equal(invalidated.length, cache + 1); assert.equal(invalidated.at(-1), url);
        assert.equal(fetches.length, outbound + 1); assert.equal(fetches.at(-1).url, url);
        const notification = db.prepare('SELECT * FROM notifications ORDER BY rowid DESC LIMIT 1').get();
        assert.equal(notification.user_id, 'author'); assert.equal(notification.space_id, f.space.id); assert.equal(notification.url, url); checks++;
      }
    }
    // Detail/list visibility is preserved for authorized readers, including agents.
    for (const [name, render] of [['detail', detail], ['list', list], ['proposal', proposal]]) {
      const allowed = visible(f, actor) && (name !== 'proposal' || !!actor);
      if (allowed) {
        const before = effectSnapshot(), result = await call(() => render(routeInput(f, cr)));
        assert.ok(result.value, `${name} ${actor?.id} ${f.marker}`);
        assert.ok(wire(result).includes(name === 'detail' ? `PROPOSED_BODY_${f.marker}` : name === 'list' ? `CR_${f.marker}` : `BODY_${f.marker}`));
        assert.deepEqual(effectSnapshot(), before); checks++;
      } else await deny(`${name} ${actor?.id} ${f.marker}`, () => render(routeInput(f, cr)));
    }
    for (const status of ['closed', 'merged']) {
      crs.setChangeRequestStatus(cr.id, status);
      await deny(`terminal ${status}`, () => actions.reviewChangeRequestAction(input(f, cr, { verdict: 'changes' })));
    }
  }
  // The ID, URL space and URL page must refer to the same persisted target.
  for (const f of fixtures) {
    const cr = newCr(f);
    crs.reviewChangeRequest(cr.id, 'reader', 'approve', `PRIVATE_REVIEW_${f.marker}`);
    for (const actor of [null, actors.outsider, actors.crossDirect, actors.crossGroup, actors.reader, actors.admin]) {
      await login(actor);
      const sameSpaceOtherPage = fixtures.find(other => other.space.id === f.space.id && other.page.id !== f.page.id);
      const otherSpace = { space: decoySpace, page: decoyPage };
      for (const params of [{ page: sameSpaceOtherPage.page.slug }, { page: 'missing-page' }, { space: otherSpace.space.slug, page: otherSpace.page.slug }, { cr: 'missing-request' }, { space: 'missing-space' }]) {
        const result = await deny('mismatched detail', () => detail(routeInput(f, cr, params)));
        for (const marker of [`BODY_${f.marker}`, `PROPOSED_BODY_${f.marker}`, `DESCRIPTION_${f.marker}`, `PRIVATE_REVIEW_${f.marker}`]) assert.ok(!wire(result).includes(marker));
      }
    }
  }
  const f = fixtures[1], cr = newCr(f);
  await login(actors.reader);
  for (const extra of [{ id: 'missing-request', verdict: 'approve' }, { id: '', verdict: 'approve' }, { verdict: 'invalid' }, { verdict: '' }]) await deny('invalid review', () => actions.reviewChangeRequestAction(input(f, cr, extra)));
  // A revoked reviewer cannot replace a historical verdict; this fix does not
  // rewrite historical reviews or reinterpret the merge policy.
  crs.reviewChangeRequest(cr.id, 'outsider', 'changes', 'Historical review');
  await login(actors.outsider);
  await deny('historical unauthorized replacement', () => actions.reviewChangeRequestAction(input(f, cr, { verdict: 'approve' })));
  assert.equal(crs.mergeCheck(crs.getChangeRequest(cr.id)).changesRequested, 1);
  // An outsider cannot create a veto; a legitimate reader can, then replace it.
  const mergeCr = newCr(f);
  await deny('outsider veto', () => actions.reviewChangeRequestAction(input(f, mergeCr, { verdict: 'changes' })));
  assert.equal(crs.mergeCheck(crs.getChangeRequest(mergeCr.id)).changesRequested, 0);
  await login(actors.reader); await call(() => actions.reviewChangeRequestAction(input(f, mergeCr, { verdict: 'changes' })));
  await login(actors.editor);
  const beforeBlocked = snapshot(); await call(() => actions.mergeChangeRequestAction(input(f, mergeCr)));
  assert.deepEqual(snapshot(), beforeBlocked); assert.equal(crs.getChangeRequest(mergeCr.id).status, 'open');
  await login(actors.reader); await call(() => actions.reviewChangeRequestAction(input(f, mergeCr, { verdict: 'approve' })));
  await deny('reader cannot merge', () => actions.mergeChangeRequestAction(input(f, mergeCr)));
  await login(actors.editor);
  assert.equal((await call(() => actions.mergeChangeRequestAction(input(f, mergeCr)))).location, `/${f.space.slug}/${f.page.slug}/changes/${mergeCr.id}`);
  assert.equal(crs.getChangeRequest(mergeCr.id).status, 'merged'); assert.equal(data.getPage(f.page.id).title, mergeCr.proposed_title); checks++;
  // Adjacent proposal actions keep their role rules and derive navigation and
  // notification URLs from actual entities, never submitted path hints.
  for (const target of fixtures) {
    for (const actor of [null, actors.outsider, actors.crossDirect, actors.crossGroup, actors.reader, actors.editor, actors.spaceAdmin, actors.author, actors.groupAgent, actors.admin]) {
      await login(actor);
      const read = visible(target, actor), request = newCr(target);
      const create = () => actions.createChangeRequestAction(form({ pageId: target.page.id, space: 'untrusted-space', title: 'NEW_PROPOSAL', proposedTitle: 'New title', proposedContent: content('NEW_BODY') }));
      if (!actor || !read) await deny('denied proposal creation', create);
      else {
        const result = await call(create); assert.ok(result.location.startsWith(`/${target.space.slug}/${target.page.slug}/changes/`)); checks++;
      }
      const beforeApi = effectSnapshot();
      const apiResponse = await createApi(new Request('http://localhost/api/change-requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pageId: target.page.id, title: 'API_PROPOSAL', proposedContent: [] }) }));
      assert.equal(apiResponse.status, !actor ? 401 : read ? 200 : 403);
      if (!actor || !read) assert.deepEqual(effectSnapshot(), beforeApi, 'denied API creation leaves all effects unchanged');
      else assert.equal(crs.getChangeRequest((await apiResponse.json()).id).author_id, actor.id);
      checks++;
      for (const [name, action] of [['close', actions.setChangeRequestStatusAction], ['rebase', actions.rebaseChangeRequestAction]]) {
        const allowed = read && actor && (actor.id === 'author' || ['spaceAdmin', 'admin'].includes(actor.id) || (!target.tenanted && ['crossDirect', 'crossGroup'].includes(actor.id)));
        const invoke = () => action(input(target, request, { status: 'closed' }));
        if (!allowed) await deny(`denied ${name}`, invoke);
        else { assert.equal((await call(invoke)).location, `/${target.space.slug}/${target.page.slug}/changes/${request.id}`); checks++; }
      }
    }
  }
  // Authorship is not continuing access after direct or tenant membership ends.
  for (const target of [fixtures[0], fixtures[4], fixtures[6]]) {
    const former = newCr(target, 'outsider');
    await login(actors.outsider);
    for (const action of [actions.reviewChangeRequestAction, actions.mergeChangeRequestAction, actions.setChangeRequestStatusAction, actions.rebaseChangeRequestAction]) await deny('former author no access', () => action(input(target, former, { verdict: 'approve', status: 'closed' })));
  }
  // Current author visibility gates only the new review notification. The
  // authorized review itself is retained; historical notifications are untouched.
  db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run('recipient', 'recipient@example.test', 'Recipient', '!', 'member', Date.now());
  db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run('synthetic-recipient', 'recipient', Date.now() + 86400000);
  load('lib/notify.ts').notify({ userId: 'recipient', actor: actors.editor, kind: 'cr.reviewed', title: 'Historical notification', body: 'HISTORICAL_RECIPIENT_NOTE' });
  for (const scenario of ['private-direct-revoked', 'private-group-revoked', 'tenant-public-revoked', 'tenant-private-revoked', 'draft-public-downgraded', 'draft-private-downgraded', 'private-reader-allowed', 'tenant-reader-allowed', 'draft-editor-allowed', 'public-nonmember-allowed', 'private-agent-allowed']) {
    const tenantScoped = scenario.startsWith('tenant');
    const published = !scenario.startsWith('draft');
    const visibility = scenario.includes('public') ? 'public' : 'private';
    let space = data.createSpace({ name: scenario, visibility });
    if (tenantScoped) { tenants.setSpaceTenant(space.id, tenant.id); tenants.addMember(tenant.id, 'recipient'); }
    roles.setSpaceMember(space.id, 'editor', 'editor');
    const recipientRole = scenario === 'private-agent-allowed' ? 'agent' : published ? 'reader' : 'editor';
    roles.setSpaceMember(space.id, 'recipient', recipientRole);
    if (scenario === 'public-nonmember-allowed') roles.removeSpaceMember(space.id, 'recipient');
    if (scenario === 'private-group-revoked' || scenario === 'tenant-private-revoked') {
      const group = groups.createGroup(scenario); groups.addGroupMember(group.id, 'recipient'); groups.setGroupGrant(group.id, space.id, 'admin');
      if (scenario === 'private-group-revoked') { roles.removeSpaceMember(space.id, 'recipient'); groups.removeGroupMember(group.id, 'recipient'); }
    }
    if (scenario === 'private-direct-revoked') roles.removeSpaceMember(space.id, 'recipient');
    if (scenario.startsWith('tenant') && scenario.endsWith('revoked')) tenants.removeMember(tenant.id, 'recipient');
    if (scenario.endsWith('downgraded')) roles.setSpaceMember(space.id, 'recipient', 'reader');
    space = data.getSpace(space.id);
    const page = data.createPage({ spaceId: space.id, title: scenario, published });
    const target = { space, page, marker: scenario }, request = newCr(target, 'recipient');
    await login(actors.editor);
    const before = snapshot(), oldNotifications = before.notifications, outbound = fetches.length, cache = invalidated.length;
    await call(() => actions.reviewChangeRequestAction(input(target, request, { verdict: 'changes', note: `RECIPIENT_NOTE_${scenario}` })));
    const after = snapshot(), notified = scenario.endsWith('allowed');
    assert.deepEqual(tables.filter(table => before[table] !== after[table]), ['change_requests', 'cr_reviews', ...(notified ? ['notifications'] : [])]);
    assert.equal(crs.listReviews(request.id).length, 1); assert.equal(crs.listReviews(request.id)[0].verdict, 'changes');
    assert.equal(fetches.length, outbound + Number(notified)); assert.equal(invalidated.length, cache + 1);
    if (!notified) assert.equal(after.notifications, oldNotifications, 'revocation leaves all existing notifications unchanged');
    else assert.equal(db.prepare('SELECT * FROM notifications ORDER BY rowid DESC LIMIT 1').get().body, `RECIPIENT_NOTE_${scenario}`);
    await login({ id: 'recipient' });
    const inboxResult = wire(await inbox());
    assert.equal(inboxResult.includes(`RECIPIENT_NOTE_${scenario}`), notified, 'actual inbox contains new review note only for current authorized author');
    assert.ok(inboxResult.includes('HISTORICAL_RECIPIENT_NOTE'), 'historical notification remains unchanged');
    if (!notified) await deny('revoked recipient detail', () => detail(routeInput(target, request)));
    checks++;
  }
  // Deleted and missing actual targets deny every action before side effects.
  for (const target of [fixtures[0], fixtures[6]]) {
    const request = newCr(target); data.deleteSpace(target.space.id, 'author');
    for (const actor of [null, actors.reader, actors.author, actors.admin]) {
      await login(actor);
      for (const action of [actions.reviewChangeRequestAction, actions.mergeChangeRequestAction, actions.setChangeRequestStatusAction, actions.rebaseChangeRequestAction]) await deny('deleted target action', () => action(input(target, request, { verdict: 'approve', status: 'closed' })));
      for (const render of [detail, proposal, list]) await deny('deleted target view', () => render(routeInput(target, request)));
      await deny('deleted target creation', () => actions.createChangeRequestAction(form({ pageId: target.page.id })));
    }
  }
  const orphanSpace = data.createSpace({ name: 'Missing actual space', visibility: 'public' });
  const orphanPage = data.createPage({ spaceId: orphanSpace.id, title: 'Orphan', published: true });
  const orphan = newCr({ space: orphanSpace, page: orphanPage, marker: 'orphan' });
  db.pragma('foreign_keys = OFF'); db.prepare('DELETE FROM spaces WHERE id=?').run(orphanSpace.id); db.pragma('foreign_keys = ON');
  await login(actors.admin);
  for (const action of [actions.reviewChangeRequestAction, actions.mergeChangeRequestAction, actions.setChangeRequestStatusAction, actions.rebaseChangeRequestAction]) await deny('missing actual space', () => action(form({ id: orphan.id, verdict: 'approve', status: 'closed' })));
  const missingPageSpace = data.createSpace({ name: 'Missing page space', visibility: 'public' });
  const missingPage = data.createPage({ spaceId: missingPageSpace.id, title: 'Removed target', published: true });
  const missingPageFixture = { space: missingPageSpace, page: missingPage, marker: 'missing-page' };
  const missingPageCr = newCr(missingPageFixture);
  // Retain the request to exercise the actual page join, not just CR deletion.
  db.pragma('foreign_keys = OFF'); db.prepare('DELETE FROM pages WHERE id=?').run(missingPage.id); db.pragma('foreign_keys = ON');
  for (const action of [actions.reviewChangeRequestAction, actions.mergeChangeRequestAction, actions.setChangeRequestStatusAction, actions.rebaseChangeRequestAction]) await deny('missing actual page', () => action(input(missingPageFixture, missingPageCr, { verdict: 'approve', status: 'closed' })));
  for (const render of [detail, proposal, list]) await deny('missing page view', () => render(routeInput(missingPageFixture, missingPageCr)));
  const beforeMissingApi = effectSnapshot();
  assert.equal((await createApi(new Request('http://localhost/api/change-requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pageId: missingPage.id, proposedContent: [] }) }))).status, 404);
  assert.deepEqual(effectSnapshot(), beforeMissingApi); checks++;
  await deny('missing page creation', () => actions.createChangeRequestAction(form({ pageId: 'missing' })));
  console.log(`PASS change-request access: ${checks} real action/route checks; all denied database/audit/notification/webhook/cache effects unchanged; real sessions; zero external requests.`);
} finally {
  if (db?.open) db.close();
  Module._load = originalLoad;
  if (originalTs) Module._extensions['.ts'] = originalTs; else delete Module._extensions['.ts'];
  if (originalTsx) Module._extensions['.tsx'] = originalTsx; else delete Module._extensions['.tsx'];
  globalThis.fetch = originalFetch;
  fs.rmSync(temporary, { recursive: true, force: true });
}
