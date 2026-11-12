/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS loader interception exercises real server exports. */
// Isolated real SQLite, session, and page exports; framework/client leaves only are stubbed.
const fs = require('fs'), path = require('path'), Module = require('module'), assert = require('assert/strict');
const base = path.resolve(__dirname, '..');
const ts = require('typescript'), root = path.join(base, 'src'), temp = fs.mkdtempSync('/tmp/octavo-page-audit-');
process.env.OCTAVO_DATA_DIR = temp;
let cookie;
const load = Module._load;
class Signal extends Error {
    constructor(kind) { super(kind); this.kind = kind; }
}
Module._load = function (name, parent, main) { if (name === 'server-only')
    return {}; if (name === 'next/navigation')
    return { redirect: () => { throw new Signal('redirect'); }, notFound: () => { throw new Signal('notFound'); } }; if (name === 'next/headers')
    return { cookies: async () => ({ get: n => n === 'octavo_session' && cookie ? { value: cookie } : undefined }), headers: async () => new Map() }; if (name === 'next/cache')
    return { revalidatePath: () => { } }; if (name.startsWith('@/components/'))
    return new Proxy({}, { get: (_, k) => k === '__esModule' ? true : function Boundary() { } }); if (name.startsWith('@/'))
    name = path.join(root, name.slice(2)); return load.call(this, name, parent, main); };
Module._extensions['.ts'] = Module._extensions['.tsx'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, f);
globalThis.fetch = () => { throw new Error('Unexpected external request'); };
const req = n => require(path.join(root, n));
const wire = v => JSON.stringify(v, (k, x) => k === 'type' || k === '_owner' ? undefined : x instanceof Map ? Object.fromEntries(x) : typeof x === 'function' ? undefined : x);
(async () => {
    const { getDb } = req('lib/db.ts'), db = getDb();
    const data = req('lib/data.ts'), sites = req('lib/sites.ts'), roles = req('lib/roles.ts');
    const user = { id: 'reader', email: 'reader@example.test', name: 'Reader', role: 'member' };
    db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(user.id, user.email, user.name, '!', user.role, Date.now());
    db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run('synthetic-reader', user.id, Date.now() + 86400000);
    const site = sites.createSite({ name: 'SECRET_DRAFT_SITE', tagline: 'SECRET_DRAFT_TAGLINE' });
    const route = req('app/sites/[site]/page.tsx');
    const params = { params: Promise.resolve({ site: site.slug }) };
    assert.deepEqual(await route.generateMetadata(params), {});
    await assert.rejects(() => route.default(params), e => e.kind === 'notFound');
    cookie = 'synthetic-reader';
    assert.deepEqual(await route.generateMetadata(params), { title: 'SECRET_DRAFT_SITE', description: 'SECRET_DRAFT_TAGLINE' });
    await route.default(params);
    cookie = undefined;
    db.prepare('UPDATE sites SET published=1 WHERE id=?').run(site.id);
    assert.equal((await route.generateMetadata(params)).title, 'SECRET_DRAFT_SITE');
    await route.default(params);
    console.log('PASS: site metadata matches draft body access; published anonymous and signed-in draft allowed');
    const space = data.createSpace({ name: 'Original space', visibility: 'private' });
    const page = data.createPage({ spaceId: space.id, title: 'Original page', published: true });
    roles.setSpaceMember(space.id, user.id, 'reader');
    db.prepare('INSERT INTO highlights(id,user_id,page_id,block_id,text,created_at) VALUES(?,?,?,?,?,?)').run('h', user.id, page.id, 'b', 'Old own highlight', Date.now());
    roles.removeSpaceMember(space.id, user.id);
    db.prepare('UPDATE spaces SET name=? WHERE id=?').run('POST_REVOCATION_SPACE_NAME', space.id);
    db.prepare('UPDATE pages SET title=? WHERE id=?').run('POST_REVOCATION_PAGE_TITLE', page.id);
    cookie = 'synthetic-reader';
    assert.equal(roles.canReadSpace(user, data.getSpace(space.id)), false);
    const highlights = wire(await req('app/highlights/page.tsx').default());
    assert.ok(!highlights.includes('POST_REVOCATION_SPACE_NAME'));
    assert.ok(!highlights.includes('POST_REVOCATION_PAGE_TITLE'));
    console.log('PASS: revoked highlights hide fresh private metadata');
    // Draft page metadata is unavailable to readers, but remains available to writers.
    roles.setSpaceMember(space.id, user.id, 'reader');
    assert.ok(wire(await req('app/highlights/page.tsx').default()).includes('POST_REVOCATION_PAGE_TITLE'));
    db.prepare('UPDATE pages SET published=0 WHERE id=?').run(page.id);
    assert.ok(!wire(await req('app/highlights/page.tsx').default()).includes('POST_REVOCATION_PAGE_TITLE'));
    roles.setSpaceMember(space.id, user.id, 'editor');
    assert.ok(wire(await req('app/highlights/page.tsx').default()).includes('POST_REVOCATION_PAGE_TITLE'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM highlights').get().n, 1, 'hidden marks are retained');
    console.log('PASS: draft reader denied, draft writer allowed; saved marks retained');
    db.close();
    fs.rmSync(temp, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(temp, { recursive: true, force: true }));
