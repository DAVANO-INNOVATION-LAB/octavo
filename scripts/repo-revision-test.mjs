// Revision pinning and guarded writes against local protocol stubs only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = mkdtempSync(path.join(tmpdir(), 'octavo-revision-'));
writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
writeFileSync(path.join(dir, 'git-host.ts'), readFileSync('src/lib/git-host.ts', 'utf8').replace('import "server-only";', ''));
const api = await import(pathToFileURL(path.join(dir, 'git-host.ts')));
const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40), MADE = 'c'.repeat(40);
let mode = 'ok', seen = [], checks = 0;
const check = (name, condition) => { assert.ok(condition, name); console.log(`ok ${++checks}: ${name}`); };
const stub = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  const url = new URL(req.url, 'http://test');
  seen.push({ method: req.method, path: url.pathname, query: url.searchParams, body: raw ? JSON.parse(raw) : null });
  const send = (data, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
  const ref = mode === 'missing' ? undefined : mode === 'invalid' ? 'main' : SHA;
  if (url.pathname.includes('/git/ref/heads/')) {
    if (mode === 'badJson') return res.writeHead(200).end('not json');
    if (mode === 'denied') return send({ message: 'denied' }, 403);
    return send({ object: { sha: mode === 'moved' ? OTHER : ref } });
  }
  if (url.pathname.includes('/repository/branches/')) return send({ commit: { id: ref } });
  if (url.pathname.includes('/refs/branches/')) return send({ target: { hash: ref } });
  if (url.pathname.endsWith('/branches')) {
    const start = url.searchParams.get('start');
    if (mode === 'dcPagination' && start === '0') return send({ values: [], isLastPage: false, nextPageStart: 2 });
    if (mode === 'dcBadPage') return send({ values: [], isLastPage: false, nextPageStart: 0 });
    return send({ values: [{ displayId: mode === 'dcMissing' ? 'other' : 'main', latestCommit: ref }], isLastPage: true });
  }
  if (url.pathname.includes('/git/trees/') && req.method === 'GET' && mode === 'missingTree') return send({ truncated: false });
  if (url.pathname.includes('/git/trees/') && req.method === 'GET') return send({ tree: [{ path: 'docs/a.md', type: 'blob', sha: SHA }], truncated: false });
  if (url.pathname.includes('/contents/')) return send({ encoding: 'base64', content: Buffer.from('body').toString('base64') });
  if (url.pathname.endsWith('/repository/tree')) return send(mode === 'cappedTree' ? Array.from({length:100}, (_, i) => ({type:'blob',path:`docs/${i}.md`,id:SHA})) : mode === 'invalidTree' ? {} : [{ type: 'blob', path: 'docs/a.md', id: SHA }]);
  if (url.pathname.includes('/repository/files/') && url.pathname.endsWith('/raw')) return res.writeHead(200).end('body');
  if (url.pathname.includes(`/src/${SHA}/`)) {
    if (url.pathname.endsWith('/a.md')) return res.writeHead(200).end('body');
    return send({ values: [{ type: 'commit_file', path: 'docs/a.md', commit: { hash: SHA } }] });
  }
  if (url.pathname.endsWith('/files')) return send({ values: ['docs/a.md'], isLastPage: true });
  if (url.pathname.includes('/raw/')) return res.writeHead(200).end('body');
  if (url.pathname.endsWith('/git/blobs')) return send({ sha: SHA });
  if (url.pathname.endsWith('/git/trees')) return send({ sha: SHA });
  if (url.pathname.endsWith('/git/commits')) return send({ sha: MADE });
  if (url.pathname.includes('/git/refs/heads/')) return mode === 'refRace' ? send({ message: 'not fast forward' }, 422) : send({ object: { sha: MADE } });
  return send({ error: 'unhandled' }, 404);
});
await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${stub.address().port}`;
const conn = provider => ({ provider, endpoint: provider === 'gitlab' ? base + '/api/v4' : base, repo: 'acme/docs', branch: 'main', path: 'docs', token: 'test' });
try {
  for (const provider of ['github', 'gitlab', 'bitbucket', 'bitbucket-dc']) {
    mode = 'ok'; seen = [];
    const c = conn(provider), revision = await api.resolveRevision(c);
    check(`${provider} resolves immutable revision`, revision.ok && revision.value === SHA);
    const pinned = { ...c, branch: revision.value };
    const listing = await api.listMarkdown(pinned), content = await api.readFile(pinned, 'a.md');
    check(`${provider} lists and reads pinned revision`, listing.ok && listing.value[0].path === 'a.md' && content.ok && content.value === 'body');
    const readRequests = seen.slice(1);
    check(`${provider} does not read mutable main after resolution`, readRequests.every(r => !r.path.includes('/main') && ![...r.query.values()].includes('main')));
    check(`${provider} every read addresses the commit`, readRequests.every(r => r.path.includes(SHA) || [...r.query.values()].includes(SHA)));
    if (provider !== 'github') {
      seen = [];
      const blocked = await api.pushFiles(c, [{ path: 'a.md', content: 'next' }], 'sync', SHA);
      check(`${provider} unsupported guarded push makes no network request`, !blocked.ok && seen.length === 0 && /not supported/.test(blocked.error));
    }
    mode = 'missing';
    check(`${provider} refuses missing commit`, !(await api.resolveRevision(c)).ok);
    mode = 'invalid';
    check(`${provider} refuses mutable ref masquerading as commit`, !(await api.resolveRevision(c)).ok);
  }
  mode = 'missingTree';
  check('GitHub rejects missing tree rather than treating it as empty', !(await api.listMarkdown(conn('github'))).ok);
  mode = 'invalidTree';
  check('GitLab rejects malformed tree', !(await api.listMarkdown(conn('gitlab'))).ok);
  mode = 'cappedTree';
  check('GitLab rejects capped partial listing', !(await api.listMarkdown(conn('gitlab'))).ok);
  mode = 'dcPagination';
  check('Data Center resolves across branch pages', (await api.resolveRevision(conn('bitbucket-dc'))).value === SHA);
  mode = 'dcBadPage';
  check('Data Center rejects non-progressing pagination', !(await api.resolveRevision(conn('bitbucket-dc'))).ok);
  mode = 'dcMissing';
  check('Data Center rejects nonmatching branch', !(await api.resolveRevision(conn('bitbucket-dc'))).ok);
  for (const errorMode of ['badJson', 'denied']) {
    mode = errorMode;
    check(`GitHub returns structured error for ${mode}`, !(await api.resolveRevision(conn('github'))).ok);
  }
  mode = 'moved'; seen = [];
  const moved = await api.pushFiles(conn('github'), [{ path: 'a.md', content: 'next' }], 'sync', SHA);
  check('GitHub detects preflight branch movement before uploading', !moved.ok && seen.length === 1 && seen[0].method === 'GET');
  mode = 'ok'; seen = [];
  const pushed = await api.pushFiles(conn('github'), [{ path: 'a.md', content: 'next' }], 'sync', SHA);
  check('GitHub guarded push returns commit', pushed.ok && pushed.value.commit === MADE);
  check('GitHub commit uses expected revision as parent', seen.find(r => r.path.endsWith('/git/commits')).body.parents[0] === SHA);
  check('GitHub ref movement explicitly forbids forced overwrite', seen.find(r => r.method === 'PATCH').body.force === false);
  mode = 'refRace';
  const raced = await api.pushFiles(conn('github'), [{ path: 'a.md', content: 'next' }], 'sync', SHA);
  check('GitHub reports intervening non-fast-forward race', !raced.ok && raced.error.includes('422'));
  console.log(`${checks} revision guard checks passed`);
} finally {
  await new Promise(resolve => stub.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
