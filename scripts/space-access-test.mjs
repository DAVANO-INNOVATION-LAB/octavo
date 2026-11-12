// Real server routes/actions and SQLite authorization; only framework/client boundaries are stubbed.
// Optional single surface: node scripts/space-access-test.mjs editor|settings|mutation|history|metadata|card|variants|restore|visitor|recovery
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = path.resolve('src');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-space-access-'));
process.env.OCTAVO_DATA_DIR = temporary;
const originalLoad = Module._load;
const originalTs = Module._extensions['.ts'], originalTsx = Module._extensions['.tsx'];
const originalFetch = globalThis.fetch;
const only = process.argv[2];
assert.ok(!only || ['editor', 'settings', 'mutation', 'history', 'metadata', 'card', 'variants', 'restore', 'visitor', 'recovery'].includes(only), 'Unknown test surface');
const enabled = surface => !only || only === surface;
let user = null, visitorToken, db, reads = [], fetches = 0;
const cachePaths = [], forwarded = [];
class Signal extends Error {
  constructor(kind, location) { super(kind); this.kind = kind; this.location = location; }
}
Module._load = function(name, parent, main) {
  if (name === 'server-only') return {};
  if (name === 'next/navigation') return {
    redirect: location => { throw new Signal('redirect', location); },
    notFound: () => { throw new Signal('notFound'); },
  };
  if (name === 'next/cache') return { revalidatePath: value => cachePaths.push(value) };
  if (name === 'next/headers') return { cookies: async () => ({ get: name => name === 'octavo_visit' && visitorToken ? { value: visitorToken } : undefined }), headers: async () => new Map() };
  if (name === 'next/og') return { ImageResponse: class { constructor(element, options) { this.element = element; this.options = options; } } };
  if (name === '@/lib/auth') return { currentUser: async () => user };
  // Keep SpaceShell real. The leaves need a browser, but their props remain available for inspection.
  if ((name.startsWith('@/components/') && name !== '@/components/SpaceShell') || (parent?.filename.endsWith('/components/SpaceShell.tsx') && name.startsWith('./'))) {
    return new Proxy({}, { get: (_, key) => key === '__esModule' ? true : function ClientBoundary() {} });
  }
  if (name === './audit-forward') return { forwardAudit: entry => forwarded.push(entry) };
  if (name.startsWith('@/')) name = path.join(root, name.slice(2));
  return originalLoad.call(this, name, parent, main);
};
Module._extensions['.ts'] = Module._extensions['.tsx'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText, file);
globalThis.fetch = () => { fetches++; throw new Error('Unexpected external request'); };
const outcome = async invoke => {
  try { return { value: await invoke() }; }
  catch (error) { if (!(error instanceof Signal)) throw error; return { signal: error.kind, location: error.location }; }
};
const wire = value => JSON.stringify(value, (key, val) => key === 'type' && typeof val !== 'string' || key === '_owner' || typeof val === 'function' ? undefined : val);
const deny = (result, label) => {
  assert.deepEqual(result, user ? { signal: 'notFound', location: undefined } : { signal: 'redirect', location: '/login' }, label);
  assert.deepEqual(reads, [], `${label}: authorization precedes page/tree/version reads`);
};
try {
  db = require('../src/lib/db.ts').getDb();
  const data = require('../src/lib/data.ts');
  const roles = require('../src/lib/roles.ts');
  const groups = require('../src/lib/groups.ts');
  const tenants = require('../src/lib/tenants.ts');
  const visitors = require('../src/lib/visitors.ts');
  const actions = require('../src/app/actions.ts');
  const editor = require('../src/app/[space]/[page]/edit/page.tsx').default;
  const settings = require('../src/app/[space]/settings/page.tsx').default;
  const histories = [
    require('../src/app/[space]/[page]/history/page.tsx').default,
    require('../src/app/[space]/[page]/history/[version]/page.tsx').default,
    require('../src/app/[space]/[page]/history/compare/page.tsx').default,
  ];
  const readerPage = require('../src/app/[space]/[page]/page.tsx').default;
  const spaceCover = require('../src/app/[space]/page.tsx').default;
  const metadata = require('../src/app/[space]/[page]/page.tsx').generateMetadata;
  const card = require('../src/app/[space]/[page]/opengraph-image.tsx').default;
  const raw = require('../src/app/[space]/[page]/raw/route.ts').GET;
  const print = require('../src/app/[space]/print/page.tsx').default;
  const printMetadata = require('../src/app/[space]/print/page.tsx').generateMetadata;
  const patch = require('../src/app/api/pages/[id]/route.ts').PATCH;
  const trash = require('../src/app/trash/page.tsx').default;
  for (const name of ['getPageBySlug', 'pageTree', 'listVersions', 'getVersion', 'variantGroups']) {
    const real = data[name];
    data[name] = (...args) => { reads.push(name); return real(...args); };
  }
  const actors = {};
  for (const name of ['owner', 'editor', 'reader', 'outsider', 'agent', 'instanceAdmin', 'groupAdmin', 'groupEditor', 'directAgent', 'groupAgent', 'outsideTenant']) {
    const role = name === 'agent' ? 'agent' : name === 'instanceAdmin' ? 'admin' : 'member';
    actors[name] = { id: name, email: `${name}@example.test`, name, role };
    db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(name, actors[name].email, name, '!', role, Date.now());
  }
  const tenant = tenants.createTenant('Synthetic tenant');
  for (const actor of Object.values(actors)) if (!['outsider', 'outsideTenant'].includes(actor.id)) tenants.addMember(tenant.id, actor.id);
  const adminGroup = groups.createGroup('Synthetic admins');
  const editorGroup = groups.createGroup('Synthetic editors');
  const agentGroup = groups.createGroup('Synthetic agents');
  for (const name of ['groupAdmin', 'directAgent']) groups.addGroupMember(adminGroup.id, name);
  groups.addGroupMember(editorGroup.id, 'groupEditor');
  groups.addGroupMember(agentGroup.id, 'groupAgent');
  const fixtures = [];
  for (const tenantScoped of [false, true]) for (const visibility of ['private', 'public']) {
    const space = data.createSpace({ name: `Fixture ${tenantScoped ? 'tenant' : 'library'} ${visibility}`, visibility });
    if (tenantScoped) tenants.setSpaceTenant(space.id, tenant.id);
    for (const [name, role] of Object.entries({ owner: 'admin', editor: 'editor', reader: 'reader', agent: 'admin', directAgent: 'agent', outsideTenant: 'admin' })) roles.setSpaceMember(space.id, name, role);
    groups.setGroupGrant(adminGroup.id, space.id, 'admin');
    groups.setGroupGrant(editorGroup.id, space.id, 'editor');
    groups.setGroupGrant(agentGroup.id, space.id, 'agent');
    const pages = [false, true].map(published => {
      const marker = `${space.slug}-${published ? 'published' : 'draft'}-secret`;
      const page = data.createPage({ spaceId: space.id, title: marker, published,
        content: JSON.stringify([{ id: marker, type: 'paragraph', content: [{ type: 'text', text: marker, styles: {} }], children: [] }]) });
      data.snapshotNow(page.id);
      return { ...page, version: data.listVersions(page.id)[0].id, marker };
    });
    fixtures.push({ space: data.getSpace(space.id), pages, tenantScoped });
  }
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const snapshot = () => wire(tables.map(table => [table, db.prepare(`SELECT * FROM "${table}"`).all().sort((a, b) => wire(a).localeCompare(wire(b)))]));
  const grants = () => wire(['users', 'space_members', 'group_members', 'group_space_roles', 'tenant_members'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const initialGrants = grants();
  const input = (fixture, page = fixture.pages[0], overrides = {}) => ({ params: Promise.resolve({ space: fixture.space.slug, page: page.slug, version: page.version, ...overrides }), searchParams: Promise.resolve({}) });
  const form = (space, extras = {}) => {
    const result = new FormData();
    for (const [key, value] of Object.entries({ slug: space.slug, name: 'Changed fixture', description: 'Updated description', visibility: 'public', kind: 'wiki', shelf: 'Test shelf', model_kind: 'robot', ...extras })) result.set(key, String(value));
    return result;
  };
  for (const fixture of fixtures) {
    const { space, pages, tenantScoped } = fixture;
    for (const actor of [null, ...Object.values(actors)]) {
      user = actor;
      const name = actor?.id ?? 'anonymous';
      const readable = roles.canReadSpace(user, space);
      const writable = readable && roles.canEditSpace(user, space.id);
      const administrable = readable && roles.canAdminSpace(user, space.id);
      assert.equal(writable, !!actor && ['owner', 'editor', 'instanceAdmin', 'groupAdmin', 'groupEditor', ...(!tenantScoped ? ['outsideTenant'] : [])].includes(name), `explicit editor matrix ${name}`);
      assert.equal(administrable, !!actor && ['owner', 'instanceAdmin', 'groupAdmin', ...(!tenantScoped ? ['outsideTenant'] : [])].includes(name), `explicit admin matrix ${name}`);
      for (const page of pages) {
        if (enabled('visitor') && !readable) for (const pageSlug of [page.slug, 'missing-private-page']) {
          reads = [];
          const result = await outcome(() => readerPage(input(fixture, page, { page: pageSlug })));
          assert.deepEqual(result, { signal: 'redirect', location: user ? '/' : '/login' });
          assert.deepEqual(reads, [], 'unreadable reader refuses before loading or checking page existence');
        }
        if (enabled('editor')) {
          reads = [];
          const result = await outcome(() => editor(input(fixture, page)));
          if (!writable) deny(result, `editor ${space.slug}/${name}`);
          else { assert.ok(wire(result).includes(page.marker)); assert.ok(wire(result).includes('initialContent')); }
        }
        if (enabled('history')) for (const history of histories) {
          reads = [];
          const result = await outcome(() => history(input(fixture, page)));
          if (!writable) deny(result, `history ${space.slug}/${name}`);
          else assert.ok(wire(result).includes(page.marker));
        }
        if (enabled('metadata')) {
          reads = [];
          const result = await metadata(input(fixture, page));
          if (!readable || (!page.published && !writable)) {
            assert.deepEqual(result, {}, `metadata ${space.slug}/${name}`);
            if (!readable) assert.deepEqual(reads, [], 'unreadable metadata loads no page');
          } else { assert.ok(result.title.includes(page.marker)); assert.ok(result.description.includes(page.marker)); }
        }
      }
      if (enabled('settings')) {
        reads = [];
        const result = await outcome(() => settings(input(fixture)));
        if (!administrable) deny(result, `settings ${space.slug}/${name}`);
        else assert.ok(wire(result).includes(space.id));
      }
      if (enabled('mutation')) for (const action of [actions.updateSpaceAction, actions.setSpaceVariantAction]) {
        const before = snapshot(), cacheBefore = cachePaths.length, forwardBefore = forwarded.length;
        const variant = action === actions.setSpaceVariantAction;
        const result = await outcome(() => action(form(space, { group: 'fixture-group', label: 'Fixture label', position: '2' })));
        assert.equal(result.signal, 'redirect');
        if (!administrable) {
          assert.equal(result.location, actor ? '/' : '/login');
          assert.equal(snapshot(), before, `denied settings leaves every table/audit unchanged: ${space.slug}/${name}`);
          assert.equal(cachePaths.length, cacheBefore);
          assert.equal(forwarded.length, forwardBefore);
          // Fields beyond the target slug must not even be consumed on denial.
          await outcome(() => action({ get(key) { assert.equal(key, 'slug'); return space.slug; } }));
        } else {
          assert.equal(result.location, `/${space.slug}${variant ? '/settings' : ''}`);
          const changed = data.getSpace(space.id);
          if (variant) {
            assert.equal(changed.variant_group, 'fixture-group');
            assert.equal(changed.variant_label, 'Fixture label');
            assert.equal(forwarded.length, forwardBefore + 1);
          } else {
            assert.equal(changed.name, 'Changed fixture');
            assert.equal(changed.visibility, 'public');
            assert.equal(changed.description, 'Updated description');
          }
          assert.equal(changed.tenant_id, space.tenant_id);
          // Restore only the synthetic fixture between independent actors.
          data.updateSpace(space.id, space);
          data.setSpaceVariant(space.id, { group: space.variant_group, label: space.variant_label, kind: space.variant_kind, position: space.variant_position });
        }
      }
    }
    if (enabled('card')) for (const page of pages) {
      user = actors.owner;
      const response = await card(input(fixture, page));
      assert.equal(response.options.headers['Cache-Control'], 'private, no-store, max-age=0');
      const result = wire(response);
      assert.equal(result.includes(page.marker), !tenantScoped && space.visibility === 'public' && page.published === 1, 'cards describe only anonymously readable published pages');
    }
  }
  if (enabled('settings')) {
    user = actors.owner;
    const otherTenant = tenants.createTenant('Other synthetic tenant');
    for (const [name, visibility, scope] of [['private-hidden-variant', 'private', null], ['tenant-hidden-variant', 'public', otherTenant.id], ['deleted-hidden-variant', 'public', null], ['visible-variant', 'public', null]]) {
      const space = data.createSpace({ name, visibility });
      if (scope) tenants.setSpaceTenant(space.id, scope);
      data.setSpaceVariant(space.id, { group: name, label: name, kind: 'version', position: 0 });
      if (name.startsWith('deleted-')) data.deleteSpace(space.id, user.id);
    }
    const rendered = wire(await settings(input(fixtures[0])));
    for (const name of ['private-hidden-variant', 'tenant-hidden-variant', 'deleted-hidden-variant']) assert.ok(!rendered.includes(name), 'settings suggestions exclude unreadable variant groups');
    assert.ok(rendered.includes('visible-variant'), 'readable variants remain available');
    const sharedKey = data.createSpace({ name: 'Hidden same-key variant', visibility: 'private' });
    data.setSpaceVariant(sharedKey.id, { group: 'visible-variant', label: 'Hidden', kind: 'version', position: 0 });
    assert.equal(data.variantGroups(roles.scopeFor(user)).find(row => row.group === 'visible-variant').count, 1, 'variant count excludes unreadable spaces');
  }
  if (enabled('variants')) {
    const variantTenant = tenants.createTenant('Variant tenant');
    const members = [];
    for (const [name, visibility, tenanted, published] of [['visible-origin', 'public', false, true], ['public-sibling', 'public', false, true], ['private-sibling', 'private', false, true], ['tenant-sibling', 'public', true, true], ['draft-sibling', 'public', false, false], ['deleted-sibling', 'public', false, true]]) {
      let space = data.createSpace({ name, visibility });
      if (tenanted) tenants.setSpaceTenant(space.id, variantTenant.id);
      data.setSpaceVariant(space.id, { group: 'bounded-variants', label: name, kind: 'version', position: 0 });
      space = data.getSpace(space.id);
      const page = data.createPage({ spaceId: space.id, title: 'Matching variant page', published });
      if (name.startsWith('deleted-')) data.deleteSpace(space.id, actors.owner.id);
      members.push({ space, pages: [page] });
    }
    const links = value => {
      if (!value || typeof value !== 'object') return null;
      if (Array.isArray(value)) { for (const v of value) { const found = links(v); if (found) return found; } return null; }
      if (value.props?.links) return value.props.links;
      return links(value.props?.children);
    };
    for (user of [null, actors.outsider, actors.owner]) {
      if (user === actors.owner) roles.setSpaceMember(members[0].space.id, user.id, 'editor');
      for (const route of [readerPage, spaceCover]) {
        const result = await route(input(members[0]));
        for (const hidden of members.filter(f => /private|tenant|deleted/.test(f.space.slug))) {
          assert.ok(!wire(result).includes(hidden.space.name));
          assert.ok(!wire(result).includes(hidden.space.slug));
        }
        assert.ok(wire(result).includes('public-sibling'));
        const draftLink = links(result).find(link => link.slug === 'draft-sibling');
        assert.equal(draftLink.href, '/draft-sibling', 'source writer does not inherit draft access in another space');
        assert.equal(draftLink.hasPage, false);
      }
    }
    user = actors.owner;
    roles.setSpaceMember(members[2].space.id, user.id, 'reader');
    roles.setSpaceMember(members[4].space.id, user.id, 'editor');
    const allowed = await readerPage(input(members[0]));
    assert.ok(wire(allowed).includes('private-sibling'));
    assert.equal(links(allowed).find(link => link.slug === 'draft-sibling').hasPage, true);
    tenants.addMember(variantTenant.id, user.id);
    assert.ok(wire(await readerPage(input(members[0]))).includes('tenant-sibling'));
    tenants.removeMember(variantTenant.id, user.id);
    for (const member of members) db.prepare('DELETE FROM space_members WHERE space_id = ?').run(member.space.id);
    const visitor = visitors.createVisitorToken({ spaceId: members[2].space.id, label: 'Variant visitor', days: 1, createdBy: user.id });
    visitorToken = visitor.token; user = null;
    const visited = links(await readerPage(input(members[2])));
    assert.ok(visited.some(link => link.current && link.slug === 'private-sibling'));
    assert.ok(visited.some(link => link.slug === 'public-sibling'));
    assert.ok(!visited.some(link => link.slug === 'tenant-sibling' || link.slug === 'deleted-sibling'));
    visitorToken = undefined;
  }
  if (enabled('restore')) {
    for (const fixture of fixtures) for (const actor of [null, ...Object.values(actors)]) {
      user = actor;
      const page = fixture.pages[0];
      data.savePage(page.id, { title: 'Current before history restore', content: '[]' });
      const before = snapshot(), cacheBefore = cachePaths.length;
      const restoreForm = new FormData(); restoreForm.set('versionId', page.version); restoreForm.set('space', fixture.space.slug);
      const allowed = roles.canReadSpace(user, fixture.space) && roles.canEditSpace(user, fixture.space.id);
      const result = await outcome(() => actions.restoreVersionAction(restoreForm));
      assert.equal(result.signal, 'redirect');
      if (!allowed) {
        assert.equal(result.location, user ? '/' : '/login');
        assert.equal(snapshot(), before, 'denied restore leaves content/history/audit unchanged');
        assert.equal(cachePaths.length, cacheBefore);
      } else {
        assert.equal(data.getPage(page.id).title, page.title);
        assert.equal(data.getPage(page.id).content, page.content);
        assert.equal(data.getPage(page.id).updated_by, user.id);
        assert.ok(data.listVersions(page.id).some(version => version.title === 'Current before history restore'), 'authorized restore preserves replaced state');
      }
      data.savePage(page.id, { title: page.title, content: page.content });
    }
    user = actors.owner;
    for (const [version, slug] of [[fixtures[2].pages[0].version, fixtures[0].space.slug], ['missing-version', fixtures[0].space.slug], [fixtures[0].pages[0].version, 'missing-space']]) {
      const before = snapshot(), form = new FormData(); form.set('versionId', version); form.set('space', slug);
      assert.equal((await outcome(() => actions.restoreVersionAction(form))).location, '/');
      assert.equal(snapshot(), before, 'mismatched/missing restore target is unchanged');
    }
  }
  if (enabled('visitor')) {
    const fixture = fixtures[2];
    const excludedGroup = groups.createGroup('Excluded tenant group');
    groups.addGroupMember(excludedGroup.id, actors.outsider.id);
    const token = visitors.createVisitorToken({ spaceId: fixture.space.id, label: 'Tenant visitor', days: 1, createdBy: actors.owner.id });
    visitorToken = token.token;
    for (const role of ['editor', 'admin']) {
      roles.setSpaceMember(fixture.space.id, actors.outsideTenant.id, role);
      groups.setGroupGrant(excludedGroup.id, fixture.space.id, role);
      for (user of [actors.outsideTenant, actors.outsider]) {
        assert.equal(roles.canReadSpace(user, fixture.space), false);
        assert.equal(roles.canEditSpace(user, fixture.space.id), false, 'retained write grants cannot cross tenant boundary');
        assert.deepEqual(await metadata(input(fixture)), {});
        const draftRaw = await raw(null, input(fixture));
        assert.equal(draftRaw.status, 404);
        assert.ok(!(await draftRaw.text()).includes(fixture.pages[0].marker));
        const publishedRaw = await raw(null, input(fixture, fixture.pages[1]));
        assert.equal(publishedRaw.status, 200);
        assert.equal(publishedRaw.headers.get('cache-control'), 'private, no-store, max-age=0');
        assert.ok((await publishedRaw.text()).includes(fixture.pages[1].marker));
        const printed = wire(await print(input(fixture)));
        assert.ok(!printed.includes(fixture.pages[0].marker));
        assert.ok(printed.includes(fixture.pages[1].marker));
        assert.equal((await outcome(() => readerPage(input(fixture)))).signal, 'notFound');
        const published = await readerPage(input(fixture, fixture.pages[1]));
        assert.ok(wire(published).includes(fixture.pages[1].marker));
        assert.ok(!wire(published).includes(fixture.pages[0].marker), 'visitor reader props/tree contain no draft');
        assert.equal(published.props.editing, false);
        assert.ok(!wire(published).includes('/propose'), 'visitor-only access has no proposal privilege');
        const cover = await spaceCover(input(fixture));
        assert.ok(!wire(cover).includes(fixture.pages[0].marker), 'visitor cover tree contains no draft');
        assert.equal(cover.props.editing, false);
        assert.ok(!wire(cover).includes(`/${fixture.space.slug}/settings`));
      }
    }
    roles.setSpaceMember(fixture.space.id, actors.outsideTenant.id, 'admin');
    groups.removeGroupMember(excludedGroup.id, actors.outsider.id);
    groups.setGroupGrant(excludedGroup.id, fixture.space.id, null);
    visitorToken = undefined;
  }
  // The capability gate protects direct writes too, not only UI/metadata.
  if (enabled('visitor')) {
    const fixture = fixtures[2], page = fixture.pages[0];
    user = actors.outsideTenant;
    assert.deepEqual(roles.capsFor(user, fixture.space.id), []);
    for (const who of [null, actors.owner, actors.instanceAdmin, actors.agent]) {
      assert.deepEqual(roles.capsFor(who, 'missing-space-id'), []);
    }
    const group = groups.createGroup('Direct mutation tenant grant');
    groups.addGroupMember(group.id, actors.outsider.id);
    for (const role of ['editor', 'admin']) {
      roles.setSpaceMember(fixture.space.id, actors.outsideTenant.id, role);
      groups.setGroupGrant(group.id, fixture.space.id, role);
      for (user of [actors.outsideTenant, actors.outsider]) {
        const before = snapshot();
        const response = await patch({ json() { throw new Error('Denied PATCH must not parse a body'); } }, { params: Promise.resolve({ id: page.id }) });
        assert.equal(response.status, 403);
        const f = new FormData(); f.set('id', page.id); f.set('space', fixture.space.slug); f.set('publish', '1');
        await outcome(() => actions.publishPageAction(f));
        await outcome(() => actions.deletePageAction(f));
        await outcome(() => actions.createPageAction(f));
        assert.equal(snapshot(), before, 'direct retained-grant writes leave all rows/history/audit unchanged');
        assert.deepEqual(await printMetadata(input(fixture)), { title: 'Print' });
      }
    }
    // The same grants work once legitimate tenant membership exists.
    for (user of [actors.outsideTenant, actors.outsider]) {
      tenants.addMember(tenant.id, user.id);
      const response = await patch({ json: async () => ({ title: 'Authorized tenant change' }) }, { params: Promise.resolve({ id: page.id }) });
      assert.equal(response.status, 200);
      assert.equal(data.getPage(page.id).title, 'Authorized tenant change');
      data.savePage(page.id, { title: page.title, content: page.content });
      assert.equal(roles.canAdminSpace(user, fixture.space.id), true);
      tenants.removeMember(tenant.id, user.id);
    }
    roles.setSpaceMember(fixture.space.id, actors.outsideTenant.id, 'admin');
    groups.removeGroupMember(group.id, actors.outsider.id); groups.setGroupGrant(group.id, fixture.space.id, null);
  }
  if (enabled('recovery')) {
    const space = data.createSpace({ name: 'Deleted tenant recovery marker' });
    tenants.setSpaceTenant(space.id, tenant.id);
    for (const name of ['owner', 'outsideTenant', 'agent']) roles.setSpaceMember(space.id, actors[name].id, 'admin');
    const recoveryGroup = groups.createGroup('Recovery group');
    groups.addGroupMember(recoveryGroup.id, actors.outsider.id);
    groups.addGroupMember(recoveryGroup.id, actors.groupAdmin.id);
    groups.setGroupGrant(recoveryGroup.id, space.id, 'admin');
    const page = data.createPage({ spaceId: space.id, title: 'Retained recovery content', published: true });
    data.deleteSpace(space.id, actors.owner.id);
    for (user of [null, actors.outsideTenant, actors.outsider, actors.agent, actors.reader]) {
      assert.equal(roles.canRestoreSpace(user, space.id), false);
      const before = snapshot(), cacheBefore = cachePaths.length, form = new FormData(); form.set('spaceId', space.id);
      const result = await outcome(() => actions.restoreSpaceAction(form));
      assert.equal(result.location, user ? '/trash' : '/login');
      assert.equal(snapshot(), before, 'denied recovery leaves deleted marker/content/audit unchanged');
      assert.equal(cachePaths.length, cacheBefore);
      const view = await outcome(() => trash({ searchParams: Promise.resolve({}) }));
      assert.ok(!wire(view).includes(space.name), 'Trash does not serialize excluded tenant spaces');
    }
    for (user of [actors.owner, actors.groupAdmin, actors.instanceAdmin]) {
      assert.equal(roles.canRestoreSpace(user, space.id), true);
      assert.ok(wire(await trash({ searchParams: Promise.resolve({}) })).includes(space.name));
      const form = new FormData(); form.set('spaceId', space.id);
      assert.equal((await outcome(() => actions.restoreSpaceAction(form))).location, '/trash?restored=1');
      assert.ok(data.getSpace(space.id)); assert.ok(data.getPage(page.id));
      data.deleteSpace(space.id, user.id);
    }
    for (user of [actors.owner, actors.instanceAdmin]) {
      assert.equal(roles.canRestoreSpace(user, 'missing-space-id'), false);
      const before = snapshot(), form = new FormData(); form.set('spaceId', 'missing-space-id');
      assert.equal((await outcome(() => actions.restoreSpaceAction(form))).location, '/trash');
      assert.equal(snapshot(), before);
    }
    for (const name of ['owner', 'outsideTenant', 'agent']) roles.removeSpaceMember(space.id, actors[name].id);
    groups.removeGroupMember(recoveryGroup.id, actors.outsider.id); groups.removeGroupMember(recoveryGroup.id, actors.groupAdmin.id);
    groups.setGroupGrant(recoveryGroup.id, space.id, null);
  }
  // Visitor tokens remain read-only, limited to one space, and revocable.
  const privateFixture = fixtures[0];
  const token = visitors.createVisitorToken({ spaceId: privateFixture.space.id, label: 'Synthetic visitor', days: 1, createdBy: actors.owner.id });
  visitorToken = token.token;
  for (user of [null, actors.outsider, actors.agent]) {
    if (enabled('editor')) { reads = []; deny(await outcome(() => editor(input(privateFixture))), 'visitor editor'); }
    if (enabled('settings')) { reads = []; deny(await outcome(() => settings(input(privateFixture))), 'visitor settings'); }
    if (enabled('metadata')) {
      assert.ok((await metadata(input(privateFixture, privateFixture.pages[1]))).title.includes(privateFixture.pages[1].marker));
      assert.deepEqual(await metadata(input(privateFixture)), {});
      if (!roles.canReadSpace(user, fixtures[2].space)) assert.deepEqual(await metadata(input(fixtures[2], fixtures[2].pages[1])), {});
    }
  }
  user = actors.outsider;
  db.prepare('UPDATE visitor_tokens SET expires_at = ? WHERE id = ?').run(Date.now() - 1, token.row.id);
  if (enabled('metadata') || enabled('visitor')) {
    assert.deepEqual(await metadata(input(privateFixture, privateFixture.pages[1])), {});
    assert.equal((await outcome(() => readerPage(input(privateFixture, privateFixture.pages[1])))).location, '/');
    assert.equal((await raw(null, input(privateFixture, privateFixture.pages[1]))).status, 404);
  }
  db.prepare('UPDATE visitor_tokens SET expires_at = ? WHERE id = ?').run(token.row.expires_at, token.row.id);
  visitors.revokeVisitorToken(token.row.id, token.row.space_id);
  user = actors.outsider;
  if (enabled('metadata')) assert.deepEqual(await metadata(input(privateFixture, privateFixture.pages[1])), {});
  visitorToken = undefined;

  // Missing/deleted targets and swapped slugs/version IDs must not borrow another target's authority.
  user = actors.owner;
  const missing = { ...privateFixture, space: { ...privateFixture.space, slug: 'missing-space' } };
  const deletedSpace = data.createSpace({ name: 'Deleted fixture' });
  roles.setSpaceMember(deletedSpace.id, user.id, 'admin');
  const deletedPage = data.createPage({ spaceId: deletedSpace.id, title: 'Deleted page secret' });
  data.deleteSpace(deletedSpace.id, user.id);
  assert.deepEqual(roles.capsFor(user, deletedSpace.id), []);
  assert.equal(roles.canRestoreSpace(user, deletedSpace.id), true, 'retained recovery grants still work');
  for (const fixture of [missing, { space: deletedSpace, pages: [deletedPage] }]) {
    if (enabled('editor')) { reads = []; deny(await outcome(() => editor(input(fixture))), 'missing/deleted editor'); }
    if (enabled('settings')) { reads = []; deny(await outcome(() => settings(input(fixture))), 'missing/deleted settings'); }
    if (enabled('metadata')) assert.deepEqual(await metadata(input(fixture)), {});
    if (enabled('card')) assert.ok(!wire(await card(input(fixture))).includes(fixture.pages[0].title));
    if (enabled('mutation')) {
      for (const action of [actions.updateSpaceAction, actions.setSpaceVariantAction]) {
        const before = snapshot();
        assert.equal((await outcome(() => action(form(fixture.space)))).location, '/');
        assert.equal(snapshot(), before);
      }
    }
  }
  const foreignPage = data.createPage({ spaceId: fixtures[1].space.id, title: 'Foreign target secret' });
  data.snapshotNow(foreignPage.id);
  for (const pageSlug of ['missing-page', foreignPage.slug]) {
    const target = input(privateFixture, privateFixture.pages[0], { page: pageSlug });
    if (enabled('editor')) assert.equal((await outcome(() => editor(target))).signal, 'notFound');
    if (enabled('metadata')) assert.deepEqual(await metadata(target), {});
  }
  if (enabled('history')) {
    const foreignVersion = data.listVersions(foreignPage.id)[0].id;
    assert.equal((await outcome(() => histories[1](input(privateFixture, undefined, { version: foreignVersion })))).signal, 'notFound');
    const target = input(privateFixture);
    target.searchParams = Promise.resolve({ from: foreignVersion });
    assert.equal((await outcome(() => histories[2](target))).signal, 'notFound');
  }
  if (enabled('mutation')) {
    const other = data.createSpace({ name: 'Unauthorized target' });
    roles.setSpaceMember(other.id, actors.outsider.id, 'admin');
    for (const action of [actions.updateSpaceAction, actions.setSpaceVariantAction]) {
      const before = snapshot();
      assert.equal((await outcome(() => action(form(other, { id: privateFixture.space.id, spaceId: privateFixture.space.id, space: privateFixture.space.slug })))).location, '/');
      assert.equal(snapshot(), before, 'an authorized decoy ID/slug does not authorize the real target');
    }
  }
  const removed = data.createPage({ spaceId: privateFixture.space.id, title: 'Removed page secret' });
  data.deletePage(removed.id);
  const removedInput = input(privateFixture, removed);
  if (enabled('editor')) assert.equal((await outcome(() => editor(removedInput))).signal, 'notFound');
  if (enabled('metadata')) assert.deepEqual(await metadata(removedInput), {});
  if (enabled('card')) assert.ok(!wire(await card(removedInput)).includes(removed.title));
  // The only grants added after the main matrix belong to the two synthetic target fixtures above.
  db.prepare('DELETE FROM space_members WHERE space_id = ?').run(deletedSpace.id);
  db.prepare('DELETE FROM space_members WHERE space_id NOT IN (' + fixtures.map(() => '?').join(',') + ')').run(...fixtures.map(f => f.space.id));
  assert.equal(grants(), initialGrants, 'existing users/direct/group/tenant grants are unchanged');
  assert.equal(require('../src/lib/audit.ts').verifyChain().ok, true);
  assert.equal(fetches, 0);
  console.log(`PASS space access${only ? ` (${only})` : ''}: real editor/settings/actions/history/metadata/card guards, role and tenant matrix, visitor limits, deleted/missing/wrong targets, no denied serialization or mutation.`);
} finally {
  db?.close();
  Module._load = originalLoad;
  if (originalTs) Module._extensions['.ts'] = originalTs; else delete Module._extensions['.ts'];
  if (originalTsx) Module._extensions['.tsx'] = originalTsx; else delete Module._extensions['.tsx'];
  globalThis.fetch = originalFetch;
  fs.rmSync(temporary, { recursive: true, force: true });
}
