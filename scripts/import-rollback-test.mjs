// Real SQLite and files, all in a fresh temporary directory. No HTTP/DNS probes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = path.resolve('src');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-import-rollback-'));
process.env.OCTAVO_DATA_DIR = temporary;
const originalLoad = Module._load, originalExtension = Module._extensions['.ts'];
const user = { id: 'importer', email: 'importer@example.test', name: 'Importer', role: 'member' };
let cacheFails = false, responseFails = false, fetches = 0;
const forwarded = [];
let forwardingFails = false;
const forwardedDuringTransaction = [];
class TestResponse extends Response {
  constructor(body, init) {
    if (responseFails) throw new Error('synthetic response failure');
    super(body, init);
  }
  static json(body, init = {}) { return new TestResponse(JSON.stringify(body), init); }
}
Module._load = function(name, parent, main) {
  if (name === 'server-only') return {};
  if (name === 'next/server') return { NextResponse: TestResponse };
  if (name === 'next/cache') return { revalidatePath: () => { if (cacheFails) throw new Error('synthetic cache failure'); } };
  if (name === 'next/headers') return { cookies: async () => ({ get: () => undefined }), headers: async () => new Map() };
  if (name === '@/lib/auth') return { currentUser: async () => user };
  if (name === '@/lib/import-url') return { fetchGuarded: async () => {
    fetches++;
    return { body: '# URL fixture\n\nSynthetic content', contentType: 'text/markdown', finalUrl: 'https://example.test/page.md' };
  } };
  if (name === './audit-forward') return { forwardAudit: (entry) => {
    forwardedDuringTransaction.push(db.inTransaction);
    if (forwardingFails) throw new Error('synthetic forwarding failure');
    forwarded.push(entry);
  } };
  if (name.startsWith('@/')) name = path.join(root, name.slice(2));
  return originalLoad.call(this, name, parent, main);
};
Module._extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, file);
let db;
try {
  const database = require('../src/lib/db.ts');
  db = database.getDb();
  const uploads = database.UPLOADS_DIR;
  const { runImportTransaction, writeImportAttachment } = require('../src/lib/import-transaction.ts');
  let asyncCalled = false;
  assert.throws(() => runImportTransaction(async () => { asyncCalled = true; }), /synchronous/);
  assert.equal(asyncCalled, false, 'async function must be rejected before invocation');
  const { importUpload } = require('../src/lib/transfer.ts');
  const { previewImport } = require('../src/lib/import-preview.ts');
  const { zip } = require('../src/lib/zip.ts');
  const { createSpace, createPage, getSpaceBySlug } = require('../src/lib/data.ts');
  const upload = require('../src/app/api/import/route.ts').POST;
  const urlImport = require('../src/app/api/import/url/route.ts').POST;
  db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)')
    .run(user.id, user.email, user.name, '!', user.role, Date.now());
  fs.mkdirSync(uploads, { recursive: true });
  fs.writeFileSync(path.join(uploads, 'unrelated.png'), 'unrelated bytes');
  const existing = createSpace({ name: 'Existing unrelated space' });
  for (const title of ['Shared image A', 'Shared image B']) createPage({
    spaceId: existing.id, parentId: null, title,
    content: JSON.stringify([{ type: 'image', props: { url: '/api/files/unrelated.png' }, children: [] }]),
  });
  const tables = ['spaces', 'pages', 'page_versions', 'space_members', 'audit_log', 'uploads', 'upload_refs', 'page_links', 'pages_fts'];
  const rows = () => JSON.stringify(tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const files = () => fs.readdirSync(uploads).sort().map(name => [name, fs.readFileSync(path.join(uploads, name)).toString('hex')]);
  const snapshot = () => JSON.stringify([rows(), files()]);
  const notebook = Buffer.from(JSON.stringify({ cells: [{ cell_type: 'code', source: ['print(1)'], outputs: [
    { data: { 'image/png': Buffer.from('synthetic png bytes').toString('base64') } },
    { data: { 'image/png': Buffer.from('second synthetic image').toString('base64') } },
  ] }] }));
  const entry = (name, text) => ({ name, data: Buffer.from(text) });
  const html = zip([
    entry('first.html', '<html><title>Fixture : First</title><div id="main-content"><p>First page</p><img src="attachments/picture.png" /></div></html>'),
    entry('second.html', '<html><title>Fixture : Second</title><div id="main-content"><p>Second page</p><img src="attachments/picture.png" /></div></html>'),
    entry('attachments/picture.png', 'synthetic html attachment'),
  ]);
  const xml = zip([
    entry('entities.xml', `<hibernate-generic>
      <object class="Space"><id name="id">1</id><property name="name">XML fixture</property><property name="key">XML</property></object>
      <object class="Page"><id name="id">2</id><property name="title">XML page</property></object>
      <object class="BodyContent"><id name="id">3</id><property name="content"><id name="id">2</id></property><property name="body"><![CDATA[<p>XML content</p><ac:image><ri:attachment ri:filename="picture.png" /></ac:image>]]></property></object>
      <object class="Attachment"><id name="id">4</id><property name="title">picture.png</property><property name="containerContent"><id name="id">2</id></property><property name="version">1</property></object>
    </hibernate-generic>`),
    entry('attachments/2/4/1', 'synthetic xml attachment'),
  ]);
  const fixtures = [['fixture.ipynb', notebook], ['html.zip', html], ['xml.zip', xml]];
  const request = (name, bytes) => {
    const form = new FormData();
    form.set('file', new File([bytes], name));
    return { headers: new Headers(), formData: async () => form };
  };
  const requestUrl = () => ({ json: async () => ({ url: 'https://example.test/page.md' }) });
  const location = response => decodeURIComponent(response.headers.get('location') ?? '');
  const trigger = (table, timing, condition = '') => db.exec(`CREATE TEMP TRIGGER fail_import ${timing} ON ${table} ${condition} BEGIN SELECT RAISE(ABORT, 'synthetic late failure'); END`);
  const untrigger = () => db.exec('DROP TRIGGER fail_import');
  // Every attachment-producing parser must leave preview read-only and clean a
  // real late ownership failure, after pages and attachment bytes already exist.
  for (const [name, bytes] of fixtures) {
    const before = snapshot();
    const preview = previewImport(name, bytes);
    assert.equal(preview.errors.length, 0, `${name}: valid preview fixture`);
    assert.equal(snapshot(), before, `${name}: preview writes nothing`);
    trigger('space_members', 'BEFORE INSERT');
    try {
      const response = await upload(request(name, bytes));
      assert.match(location(response), /synthetic late failure/);
      assert.equal(response.status, 303);
      assert.equal(snapshot(), before, `${name}: ownership failure rolls back rows and own files`);
    } finally { untrigger(); }
    const result = runImportTransaction(() => importUpload(name, bytes));
    assert.ok(getSpaceBySlug(result.spaceSlug));
    assert.ok(files().length > JSON.parse(before)[1].length, `${name}: attachment fixture actually writes files`);
  }
  // Actual upload handlers attribute all file-producing parsers, atomically.
  const access = require('../src/lib/uploads.ts');
  for (const [name, bytes] of fixtures) {
    const before = snapshot();
    trigger('uploads', 'BEFORE INSERT');
    try {
      assert.match(location(await upload(request(name, bytes))), /synthetic late failure/);
      assert.equal(snapshot(), before, `${name}: provenance failure rolls back bytes and content`);
    } finally { untrigger(); }
    const response = await upload(request(name, bytes));
    assert.equal(response.status, 303);
    const space = getSpaceBySlug(location(response).slice(1));
    assert.ok(space, `${name}: successful attributed import`);
    const records = db.prepare('SELECT name, uploaded_by FROM uploads WHERE space_id=?').all(space.id);
    assert.ok(records.length > 0, `${name}: attachment provenance retained`);
    for (const record of records) {
      assert.equal(record.uploaded_by, user.id);
      assert.equal(access.canReadUpload(user, record.name), true);
      assert.equal(access.canReadUpload(null, record.name), false);
    }
  }
  // Failure while a multi-page parser is still writing, rather than at ownership.
  {
    const before = snapshot();
    trigger('pages', 'BEFORE INSERT', "WHEN NEW.title = 'Second'");
    try {
      assert.match(location(await upload(request('html.zip', html))), /synthetic late failure/);
      assert.equal(snapshot(), before, 'late page failure rolls back earlier page and attachments');
    } finally { untrigger(); }
  }
  // Publication is part of both import transactions.
  for (const invoke of [() => upload(request('fixture.ipynb', notebook)), () => urlImport(requestUrl())]) {
    const before = snapshot();
    trigger('pages', 'BEFORE UPDATE OF published', 'WHEN NEW.published = 1');
    try {
      const response = await invoke();
      assert.ok(response.status === 400 || /error=/.test(location(response)));
      assert.equal(snapshot(), before, 'publication failure rolls back all writes');
    } finally { untrigger(); }
  }
  for (const table of ['space_members', 'pages', 'audit_log']) {
    const before = snapshot(), forwardedBefore = forwarded.length;
    trigger(table, 'BEFORE INSERT');
    try {
      const response = await urlImport(requestUrl());
      assert.equal(response.status, 400, `URL ${table} failure is reported`);
      assert.equal(snapshot(), before, `URL ${table} failure rolls back all writes`);
      assert.equal(forwarded.length, forwardedBefore, 'uncommitted audit is not forwarded');
    } finally { untrigger(); }
  }
  // A deferred foreign-key violation occurs at COMMIT, after the callback has
  // returned successfully. The attachment ledger must survive until that point.
  db.exec('CREATE TABLE import_deferred (user_id TEXT REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED)');
  {
    const before = snapshot();
    assert.throws(() => runImportTransaction(() => {
      createSpace({ name: 'Commit failure' });
      writeImportAttachment('commit-failure.png', Buffer.from('new file'));
      db.prepare('INSERT INTO import_deferred VALUES (?)').run('nonexistent-user');
    }), /FOREIGN KEY/);
    assert.equal(snapshot(), before, 'COMMIT failure cleans new files and rolls back rows');
    assert.equal(db.prepare('SELECT count(*) AS n FROM import_deferred').get().n, 0);
  }
  // The URL route must defer external audit forwarding until its OUTERMOST
  // transaction commits, including when the audit insert itself succeeds.
  {
    const before = snapshot(), forwardedBefore = forwarded.length;
    db.exec("CREATE TEMP TRIGGER defer_url_failure AFTER INSERT ON audit_log BEGIN INSERT INTO import_deferred VALUES ('missing-url-user'); END");
    try {
      const response = await urlImport(requestUrl());
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /FOREIGN KEY/);
      assert.equal(snapshot(), before);
      assert.equal(forwarded.length, forwardedBefore, 'failed outer COMMIT must not forward audit');
    } finally { db.exec('DROP TRIGGER defer_url_failure'); }
  }
  // Exclusive creation must not claim an existing file, even on a collision.
  {
    const before = snapshot();
    assert.throws(() => runImportTransaction(() => {
      writeImportAttachment('unrelated.png', Buffer.from('must not overwrite'));
    }), /EEXIST/);
    assert.equal(snapshot(), before);
    for (const name of ['../escape.png', '/escape.png', 'a/b.png', 'a\\b.png', '.', '..', ''])
      assert.throws(() => writeImportAttachment(name, Buffer.from('x')), /Invalid/);
  }
  // A partial write can leave bytes on disk before raising an error.
  {
    const before = snapshot(), originalWrite = fs.writeFileSync;
    fs.writeFileSync = (fd, bytes, ...args) => {
      if (typeof fd === 'number') {
        originalWrite(fd, bytes.subarray(0, 3), ...args);
        throw new Error('synthetic partial write');
      }
      return originalWrite(fd, bytes, ...args);
    };
    try {
      assert.throws(() => runImportTransaction(() => {
        createSpace({ name: 'Partial write' });
        writeImportAttachment('partial.png', Buffer.from('partial data'));
      }), /synthetic partial write/);
      assert.equal(snapshot(), before);
      assert.throws(() => writeImportAttachment('standalone-partial.png', Buffer.from('partial data')), /synthetic partial write/);
      assert.equal(snapshot(), before, 'standalone writer also cleans partial file');
    } finally { fs.writeFileSync = originalWrite; }
  }
  {
    const before = snapshot(), originalClose = fs.closeSync;
    let once = true;
    fs.closeSync = fd => {
      originalClose(fd);
      if (once) { once = false; throw new Error('synthetic finalization failure'); }
    };
    try {
      assert.throws(() => runImportTransaction(() => {
        createSpace({ name: 'Close failure' });
        writeImportAttachment('close-failure.png', Buffer.from('file bytes'));
      }), /synthetic finalization failure/);
      assert.equal(snapshot(), before);
    } finally { fs.closeSync = originalClose; }
  }
  // If the OS cannot establish the exclusively opened file's identity, leave
  // it untouched and report incomplete cleanup rather than claim full rollback.
  {
    const beforeRows = rows(), beforeFiles = files(), originalStat = fs.fstatSync;
    fs.fstatSync = () => { throw new Error('synthetic identity read failure'); };
    try {
      assert.throws(() => runImportTransaction(() => {
        createSpace({ name: 'Identity failure' });
        writeImportAttachment('identity-failure.png', Buffer.from('data'));
      }), error => {
        assert.match(error.message, /cleanup incomplete/i);
        assert.match(error.cause.message, /synthetic identity read failure/);
        return true;
      });
      assert.equal(rows(), beforeRows);
    } finally { fs.fstatSync = originalStat; }
    assert.equal(fs.existsSync(path.join(uploads, 'identity-failure.png')), true);
    fs.unlinkSync(path.join(uploads, 'identity-failure.png'));
    assert.deepEqual(files(), beforeFiles);
  }
  // Unlink failure must be disclosed; DB rollback must still complete, cleanup
  // must attempt the other owned files, and unrelated content remains intact.
  {
    const beforeRows = rows(), beforeFiles = files(), originalUnlink = fs.unlinkSync;
    fs.unlinkSync = file => {
      if (String(file).endsWith('/blocked.png')) throw new Error('synthetic unlink denied');
      return originalUnlink(file);
    };
    try {
      assert.throws(() => runImportTransaction(() => {
        createSpace({ name: 'Cleanup failure' });
        writeImportAttachment('other-owned.png', Buffer.from('must be removed'));
        writeImportAttachment('blocked.png', Buffer.from('cleanup blocked'));
        throw new Error('original operation failure');
      }), error => {
        assert.match(error.message, /cleanup incomplete/i);
        assert.match(error.cause.message, /original operation failure/);
        return true;
      });
      assert.equal(rows(), beforeRows);
      assert.equal(fs.existsSync(path.join(uploads, 'other-owned.png')), false);
      assert.equal(fs.existsSync(path.join(uploads, 'blocked.png')), true);
    } finally { fs.unlinkSync = originalUnlink; }
    fs.unlinkSync(path.join(uploads, 'blocked.png'));
    assert.deepEqual(files(), beforeFiles);
  }
  // Another actor replacing an owned path is not permission to delete it.
  {
    const replaced = path.join(uploads, 'replaced.png');
    assert.throws(() => runImportTransaction(() => {
      writeImportAttachment('replaced.png', Buffer.from('ours'));
      fs.renameSync(replaced, path.join(temporary, 'original-owned.png'));
      fs.writeFileSync(replaced, 'replacement belongs to another actor');
      throw new Error('late failure');
    }), /cleanup incomplete/i);
    assert.equal(fs.readFileSync(replaced, 'utf8'), 'replacement belongs to another actor');
    fs.unlinkSync(replaced);
  }
  assert.throws(() => db.transaction(() => runImportTransaction(() => {}))(), /outermost/);
  assert.throws(() => runImportTransaction(() => Promise.resolve('not synchronous')), /synchronous/);
  // Cache and response failures occur after commit. They must never delete
  // retained attachments or misreport a committed import as an import error.
  {
    cacheFails = true;
    const beforeFiles = files().length;
    const response = await upload(request('fixture.ipynb', notebook));
    cacheFails = false;
    assert.equal(response.status, 303);
    assert.doesNotMatch(location(response), /error=/);
    const space = getSpaceBySlug(location(response).slice(1));
    assert.ok(space);
    assert.equal(db.prepare('SELECT role FROM space_members WHERE space_id=? AND user_id=?').get(space.id, user.id).role, 'admin');
    assert.ok(files().length > beforeFiles);
  }
  for (const invoke of [() => upload(request('fixture.ipynb', notebook)), () => urlImport(requestUrl())]) {
    const beforeSpaces = db.prepare('SELECT count(*) AS n FROM spaces').get().n;
    responseFails = true;
    try { await assert.rejects(invoke, /synthetic response failure/); }
    finally { responseFails = false; }
    assert.equal(db.prepare('SELECT count(*) AS n FROM spaces').get().n, beforeSpaces + 1, 'response error does not roll back committed import');
  }
  {
    const response = await urlImport(requestUrl());
    assert.equal(response.status, 200);
    const result = await response.json(), space = getSpaceBySlug(result.spaceSlug);
    assert.ok(space);
    assert.equal(db.prepare('SELECT published FROM pages WHERE space_id=?').get(space.id).published, 1);
    assert.equal(db.prepare('SELECT role FROM space_members WHERE space_id=? AND user_id=?').get(space.id, user.id).role, 'admin');
    assert.equal(db.prepare('SELECT count(*) AS n FROM audit_log WHERE space_id=?').get(space.id).n, 1);
  }
  {
    forwardingFails = true;
    const beforeSpaces = db.prepare('SELECT count(*) AS n FROM spaces').get().n;
    try { assert.equal((await urlImport(requestUrl())).status, 200); }
    finally { forwardingFails = false; }
    assert.equal(db.prepare('SELECT count(*) AS n FROM spaces').get().n, beforeSpaces + 1);
  }
  assert.ok(forwarded.length > 0, 'successful URL imports forward audit');
  assert.ok(forwardedDuringTransaction.every(value => !value), 'audit forwarding only runs after commit');
  assert.ok(fetches > 0);
  assert.equal(fs.readFileSync(path.join(uploads, 'unrelated.png'), 'utf8'), 'unrelated bytes');
  console.log('PASS import rollback: actual upload/URL handlers, notebook/HTML/XML files, late pages/ownership/publication/audit failures, commit failure, partial writes, finalization, exclusive collision, cleanup errors, replacement preservation, preview, successful retention and post-commit errors.');
} finally {
  db?.close();
  Module._load = originalLoad;
  if (originalExtension) Module._extensions['.ts'] = originalExtension;
  else delete Module._extensions['.ts'];
  fs.rmSync(temporary, { recursive: true, force: true });
}
