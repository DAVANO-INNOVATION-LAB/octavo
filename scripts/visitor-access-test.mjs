// Visitor revocation executes real actions, sessions, SQLite and authorization.
// Framework boundaries are isolated; all fixtures are temporary and synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url), root = path.resolve('src');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-visitor-access-'));
process.env.OCTAVO_DATA_DIR = temporary;
const originalLoad = Module._load, originalTs = Module._extensions['.ts'], originalFetch = globalThis.fetch;
let cookie, db, checks = 0;
const effects = [];
class Redirect extends Error { constructor(location) { super(location); this.location = location; } }
Module._load = function(name, parent, main) {
  if (name === 'server-only') return {};
  if (name === 'next/navigation') return { redirect: location => { throw new Redirect(location); } };
  if (name === 'next/cache') return { revalidatePath: value => effects.push(value) };
  if (name === 'next/headers') return { cookies: async () => ({ get: name => name === 'octavo_session' && cookie ? { value: cookie } : undefined }), headers: async () => new Map() };
  if (name.startsWith('@/')) name = path.join(root, name.slice(2));
  return originalLoad.call(this, name, parent, main);
};
Module._extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, file);
globalThis.fetch = async () => { throw new Error('No network allowed'); };
const load = name => require(path.join(root, name));
const form = values => { const f = new FormData(); for (const [key, value] of Object.entries(values)) f.set(key, String(value)); return f; };
try {
  db = load('lib/db.ts').getDb();
  const data = load('lib/data.ts'), roles = load('lib/roles.ts'), visitors = load('lib/visitors.ts');
  const auth = load('lib/auth.ts'), tenants = load('lib/tenants.ts'), groups = load('lib/groups.ts');
  const action = load('app/actions.ts').revokeVisitorTokenAction;
  const names = ['owner', 'other', 'reader', 'editor', 'outsider', 'crossTenant', 'instanceAgent', 'directAgent', 'groupAgent', 'groupAdmin', 'instanceAdmin'];
  for (const name of names) {
    const role = name === 'instanceAdmin' ? 'admin' : name === 'instanceAgent' ? 'agent' : 'member';
    db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(name, `${name}@example.test`, name, '!', role, Date.now());
    db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run(`synthetic-${name}`, name, Date.now() + 86400000);
  }
  const tenant = tenants.createTenant('Visitor tenant');
  for (const name of names.filter(name => name !== 'crossTenant')) tenants.addMember(tenant.id, name);
  const adminGroup = groups.createGroup('Admins'), agentGroup = groups.createGroup('Agents');
  groups.addGroupMember(adminGroup.id, 'groupAdmin'); groups.addGroupMember(agentGroup.id, 'groupAgent');
  const fixtures = [];
  for (const tenanted of [false, true]) for (const visibility of ['private', 'public']) {
    const space = data.createSpace({ name: `${tenanted}-${visibility}`, visibility });
    if (tenanted) tenants.setSpaceTenant(space.id, tenant.id);
    for (const [name, role] of Object.entries({ owner: 'admin', reader: 'reader', editor: 'editor', crossTenant: 'admin', instanceAgent: 'admin', directAgent: 'agent' })) roles.setSpaceMember(space.id, name, role);
    groups.setGroupGrant(adminGroup.id, space.id, 'admin'); groups.setGroupGrant(agentGroup.id, space.id, 'agent');
    fixtures.push({ space: data.getSpace(space.id), tenanted });
  }
  const decoy = data.createSpace({ name: 'Other administrator space', visibility: 'private' });
  roles.setSpaceMember(decoy.id, 'other', 'admin');
  const token = space => visitors.createVisitorToken({ spaceId: space.id, label: 'Synthetic visitor', days: 7, createdBy: 'owner' }).row;
  const getToken = id => db.prepare('SELECT * FROM visitor_tokens WHERE id=?').get(id);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const snapshot = () => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM "${table}"`).all().map(row => JSON.stringify(row)).sort()]));
  const invoke = async (actor, space, id) => {
    cookie = actor ? `synthetic-${actor}` : undefined;
    assert.equal((await auth.currentUser())?.id, actor ?? undefined);
    try { await action(form({ space: space.slug, id })); assert.fail('Action should redirect'); }
    catch (e) { if (!(e instanceof Redirect)) throw e; return e.location; }
  };
  const login = async actor => { cookie = actor ? `synthetic-${actor}` : undefined; await auth.currentUser(); };
  const unchanged = async (actor, space, id) => {
    await login(actor);
    const before = snapshot(), cache = [...effects];
    await invoke(actor, space, id);
    assert.deepEqual(snapshot(), before, 'Denied/missing/mismatched token does not alter any table or audit');
    assert.deepEqual(effects, cache); checks++;
  };
  for (const fixture of fixtures) {
    const { space, tenanted } = fixture;
    for (const actor of [null, ...names]) {
      const row = token(space);
      const allowed = ['owner', 'groupAdmin', 'instanceAdmin'].includes(actor) || (actor === 'crossTenant' && !tenanted);
      if (!allowed) await unchanged(actor, space, row.id);
      else {
        await login(actor);
        const before = snapshot();
        assert.equal(await invoke(actor, space, row.id), `/${space.slug}/members`);
        assert.ok(getToken(row.id).revoked_at);
        const after = snapshot();
        assert.deepEqual(tables.filter(table => JSON.stringify(before[table]) !== JSON.stringify(after[table])), ['audit_log', 'visitor_tokens']);
        const audit = db.prepare("SELECT * FROM audit_log WHERE action='visit.token_revoked' ORDER BY rowid DESC LIMIT 1").get();
        assert.equal(audit.space_id, space.id); assert.equal(audit.actor_id, actor); checks++;
        await unchanged(actor, space, row.id); // Repeated revoke is not a fresh audited mutation.
      }
      // Using an independently authorized decoy cannot revoke a foreign token,
      // including for an instance administrator: IDs must match the form target.
      const foreign = token(space);
      await unchanged(actor, decoy, foreign.id);
      assert.equal(getToken(foreign.id).revoked_at, null);
    }
    for (const id of ['', 'missing-token']) await unchanged('owner', space, id);
    const dead = token(space); data.deleteSpace(space.id, 'owner');
    await unchanged('owner', space, dead.id); await unchanged('instanceAdmin', space, dead.id);
    data.restoreSpace(space.id);
  }
  const row = token(decoy);
  // The storage helper also enforces the ownership predicate, not merely the UI.
  assert.equal(visitors.revokeVisitorToken(row.id, fixtures[0].space.id), false);
  assert.equal(getToken(row.id).revoked_at, null);
  assert.equal(visitors.revokeVisitorToken(row.id, decoy.id), true);
  assert.equal(visitors.revokeVisitorToken(row.id, decoy.id), false); checks += 4;
  console.log(`Visitor access: ${checks} actual-action/storage checks passed`);
} finally {
  db?.close(); globalThis.fetch = originalFetch; Module._load = originalLoad; Module._extensions['.ts'] = originalTs;
  fs.rmSync(temporary, { recursive: true, force: true });
}
