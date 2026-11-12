// Real SQLite fixtures only. Never imports the application DB or reads data/.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import Database from 'better-sqlite3';
function load(file, dependencies, extras = {}) {
  const exports = {};
  const source = fs.readFileSync(file, 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
    { exports, require: name => { assert.ok(name in dependencies, name); return dependencies[name]; }, Buffer, console, ...extras });
  return exports;
}
let fault = '';
const fakeFs = new Proxy(fs, { get(target, name) {
  if (name === "__esModule") return false;
  return (...args) => {
    if ((fault === 'write' && name === 'writeFileSync') ||
        (fault === 'sync' && name === 'fsyncSync') ||
        (fault === 'backup-rename' && name === 'renameSync' && String(args[0]).endsWith('rollback.db')) ||
        (fault === 'swap' && name === 'renameSync' && String(args[0]).endsWith('candidate.db')))
      throw new Error(`injected ${fault}`);
    return target[name](...args);
  };
} });
const { RestoreError, restoreSnapshot, validateSnapshot } = load('src/lib/restore.ts', {
  'node:fs': fakeFs, 'node:path': path, 'node:crypto': crypto, 'better-sqlite3': Database,
});
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-restore-test-'));
function fixture(filename, value, accounts = true) {
  const db = new Database(filename);
  db.exec('CREATE TABLE users(id TEXT); CREATE TABLE spaces(id TEXT); CREATE TABLE pages(id TEXT, body TEXT);');
  if (accounts) db.prepare('INSERT INTO users VALUES (?)').run(value);
  db.prepare('INSERT INTO pages VALUES (?, ?)').run(value, 'body'.repeat(4000));
  db.close();
}
let count = 0;
try {
  const incoming = path.join(root, 'incoming.db'); fixture(incoming, 'incoming');
  const bytes = fs.readFileSync(incoming);
  const empty = path.join(root, 'empty.db'); fixture(empty, 'empty', false);
  assert.throws(() => validateSnapshot(empty), /no accounts/);
  const bad = path.join(root, 'bad.db'); fs.writeFileSync(bad, 'not SQLite');
  assert.throws(() => validateSnapshot(bad));
  const corrupt = Buffer.from(bytes);
  const probe = new Database(incoming); const page = probe.prepare("SELECT rootpage FROM sqlite_master WHERE name='pages'").get().rootpage; probe.close();
  corrupt[(page - 1) * 4096] = 0xff;
  fs.writeFileSync(bad, corrupt); assert.throws(() => validateSnapshot(bad));
  for (const scenario of ['write', 'sync', 'backup', 'backup-corrupt', 'backup-rename', 'checkpoint', 'close', 'swap', 'corrupt', 'success']) {
    const dir = fs.mkdtempSync(path.join(root, 'case-'));
    const live = path.join(dir, 'octavo.db'); fixture(live, 'outgoing');
    let db = new Database(live); db.pragma('journal_mode = WAL');
    db.prepare('INSERT INTO users VALUES (?)').run('wal-only');
    const wrapped = new Proxy(db, { get(target, name) {
      if (scenario === 'backup-corrupt' && name === 'prepare') return sql => {
        const stmt = target.prepare(sql);
        return sql.startsWith('VACUUM') ? { run(filename) { stmt.run(filename); fs.writeFileSync(filename, 'broken backup'); } } : stmt;
      };
      if (scenario === 'backup' && name === 'prepare') return sql => { if (sql.startsWith('VACUUM')) throw new Error('injected backup'); return target.prepare(sql); };
      if (scenario === 'checkpoint' && name === 'pragma') return sql => sql.startsWith('wal_checkpoint') ? [{ busy: 1 }] : target.pragma(sql);
      if (scenario === 'close' && name === 'close') return () => { throw new Error('injected close'); };
      const value = target[name]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    let reset = false; fault = scenario;
    const run = () => restoreSnapshot(scenario === 'corrupt' ? corrupt : bytes, dir, () => wrapped, () => { reset = true; });
    if (scenario === 'success') run(); else assert.throws(run);
    fault = '';
    if (db.open) db.close();
    db = new Database(live);
    assert.deepEqual(db.prepare('SELECT id FROM users ORDER BY id').all().map(r => r.id), scenario === 'success' ? ['incoming'] : ['outgoing', 'wal-only'], scenario);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); db.close();
    assert.equal(reset, ['success', 'swap'].includes(scenario), scenario);
    assert.ok(!fs.readdirSync(dir).some(n => n.startsWith('.octavo-restore-')), scenario);
    const backups = fs.readdirSync(dir).filter(n => n.startsWith('octavo-replaced-'));
    if (['success', 'swap', 'checkpoint', 'close'].includes(scenario)) {
      assert.equal(backups.length, 1, scenario); const rollback = new Database(path.join(dir, backups[0]));
      assert.deepEqual(rollback.prepare('SELECT id FROM users ORDER BY id').all().map(r => r.id), ['outgoing', 'wal-only']); rollback.close();
    } else assert.equal(backups.length, 0);
    count++;
  }
  // Route authorization, confirmation, overlapping uploads, lock release and failures.
  let user = { role: 'admin' }, restores = 0, shouldFail = false;
  const env = { OCTAVO_COLLAB: "0" };
  const { POST } = load('src/app/api/admin/restore/route.ts', {
    'next/server': { NextResponse: { redirect: url => ({ url: String(url), cookies: { delete() {} } }) } },
    '@/lib/auth': { currentUser: async () => user },
    '@/lib/db': { DATA_DIR: root, getDb() { throw new Error('must not open real DB'); } },
    '@/lib/restore': { RestoreError, restoreSnapshot() { restores++; if (shouldFail) throw new Error('injected restore'); } },
  }, { File, URL, process: { env }, console: { error() {} } });
  const form = new FormData(); form.set('file', new File([bytes], 'fixture.db')); form.set('confirm', 'REPLACE');
  const request = { url: 'http://localhost/api/admin/restore', formData: async () => form };
  user = null; assert.match((await POST(request)).url, /login/); assert.equal(restores, 0); user = { role: 'admin' };
  delete env.OCTAVO_COLLAB; assert.match((await POST(request)).url, /OCTAVO_COLLAB/); assert.equal(restores, 0);
  env.OCTAVO_COLLAB = '1'; assert.match((await POST(request)).url, /OCTAVO_COLLAB/); assert.equal(restores, 0); env.OCTAVO_COLLAB = '0';
  form.set('confirm', 'NO'); assert.match((await POST(request)).url, /error=/); assert.equal(restores, 0); form.set('confirm', 'REPLACE');
  let release;
  const pending = POST({ ...request, formData: () => new Promise(resolve => { release = () => resolve(form); }) });
  await Promise.resolve(); assert.match((await POST(request)).url, /another%20restore/); release();
  assert.match((await pending).url, /restored=1/); assert.equal(restores, 1);
  shouldFail = true; assert.match((await POST(request)).url, /error=/);
  shouldFail = false; assert.match((await POST(request)).url, /restored=1/);
  console.log(`PASS restore: ${count} synthetic SQLite scenarios, corrupt/empty validation, rollback WAL data, cleanup, authorization, confirmation and concurrency.`);
} finally { fault = ''; fs.rmSync(root, { recursive: true, force: true }); }
