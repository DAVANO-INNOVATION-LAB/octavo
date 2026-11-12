// Only synthetic DNS/HTTP fixtures. No sockets, network probes or unsafe route mode.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import * as stream from 'node:stream';
import * as streams from 'node:stream/promises';
import * as zlib from 'node:zlib';
import ts from 'typescript';
import http from 'node:http';
import https from 'node:https';

const MAX = 5 * 1024 * 1024;
let answers, fixtures, calls, lookups, responses, requests, timers;
function reset() {
  answers = [{ address: '8.8.8.8', family: 4 }]; fixtures = [];
  calls = []; lookups = []; responses = []; requests = []; timers = new Set();
}
reset();
const request = (url, options, callback) => {
  const req = new EventEmitter();
  requests.push(req);
  req.destroyed = false;
  req.end = () => queueMicrotask(() => {
    if (options.signal.aborted) return;
    const fixture = fixtures.shift(); assert.ok(fixture, 'unexpected request');
    assert.equal(options.agent, false);
    assert.equal(options.autoSelectFamily, false);
    assert.equal(options.maxHeaderSize, 16 * 1024);
    let destination;
    options.lookup(url.hostname, {}, (error, address, family) => {
      assert.equal(error, null); destination = { address, family };
    });
    assert.ok(destination, 'connection lookup must use the validated result synchronously');
    calls.push({ url: url.toString(), destination, options });
    if (fixture.error) { req.emit('error', new Error(fixture.error)); return; }
    if (fixture.noHeaders) return;
    const res = fixture.hang ? new stream.PassThrough() : stream.Readable.from(fixture.chunks ?? ['hello']);
    res.statusCode = fixture.status ?? 200;
    res.headers = fixture.headers ?? { 'content-type': 'text/plain' };
    responses.push(res);
    callback(res);
    if (fixture.broken) queueMicrotask(() => res.destroy(new Error('truncated response')));
  });
  const abort = () => {
    req.destroyed = true;
    req.emit('error', options.signal.reason);
  };
  options.signal.addEventListener('abort', abort, { once: true });
  return req;
};
const exports = {};
const dependencies = {
  'node:net': net,
  'node:dns/promises': { lookup: async (host, options) => {
    lookups.push(host); assert.equal(options.all, true); assert.equal(options.verbatim, true);
    return typeof answers === 'function' ? answers(host) : answers;
  } },
  'node:http': { request }, 'node:https': { request },
  'node:stream': stream, 'node:stream/promises': streams, 'node:zlib': zlib,
};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/import-url.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, {
  exports, Buffer, URL, AbortController,
  setTimeout: (fn, delay) => {
    assert.equal(delay, 15_000, 'one whole-operation production deadline');
    const timer = setTimeout(fn, 150); timers.add(timer); return timer;
  },
  clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); },
  require: name => { assert.ok(name in dependencies, name); return dependencies[name]; },
});
const { isPublicImportAddress: allowed, fetchGuarded: fetch } = exports;
let count = 0;
async function test(name, fn) {
  reset(); await fn();
  assert.equal(timers.size, 0, `${name}: timers cleaned`);
  assert.ok(responses.every(res => res.destroyed), `${name}: responses closed`);
  assert.ok(requests.every(req => req.destroyed), `${name}: requests aborted on completion`);
  console.log(`PASS ${name}`); count++;
}
await test('IPv4 special-use fence and public addresses', async () => {
  for (const ip of ['0.1.2.3','10.0.0.1','100.64.0.0','100.127.255.255','127.1.2.3','169.254.1.1','172.16.0.0','172.31.255.255','192.0.0.9','192.0.2.1','192.88.99.1','192.168.1.2','198.18.0.1','198.19.255.255','198.51.100.2','203.0.113.2','224.0.0.0','239.1.2.3','240.1.2.3','255.255.255.255','999.1.2.3']) assert.equal(allowed(ip), false, ip);
  for (const ip of ['8.8.8.8','1.1.1.1','100.63.255.255','100.128.0.0','172.15.255.255','172.32.0.0','192.0.1.1','223.255.255.255']) assert.equal(allowed(ip), true, ip);
});
await test('IPv6 special-use, translation and mapped forms', async () => {
  for (const ip of ['::','::1','::ffff:127.0.0.1','::ffff:7f00:1','::ffff:8.8.8.8','::127.0.0.1','64:ff9b::7f00:1','64:ff9b:1::1','100::1','2001::1','2001:20::1','2001:db8::1','2002:7f00:1::','3fff::1','3fff:fff::1','fc00::1','fd00::1','fe80::1','febf::1','fe80::1%eth0','ff02::1','4000::1']) assert.equal(allowed(ip), false, ip);
  for (const ip of ['2001:4860:4860::8888','2606:4700:4700::1111','2a00:1450::1']) assert.equal(allowed(ip), true, ip);
});
await test('canonicalized IPv4 literals and hostname aliases blocked', async () => {
  for (const url of ['http://2130706433','http://0x7f000001','http://0177.0.0.1','http://127.1','http://[::ffff:127.0.0.1]','http://localhost.','http://x.localhost.','http://x.local.']) await assert.rejects(fetch(url), /not public/);
  answers = [{address:'127.0.0.1',family:4}];
  await assert.rejects(fetch('https://alias.example.test'), /not public/);
  assert.equal(calls.length, 0);
});
await test('scheme, credentials, empty and mismatched DNS rejected', async () => {
  for (const url of ['file:///tmp/a','ftp://example.test']) await assert.rejects(fetch(url), /only http/);
  await assert.rejects(fetch('https://user:pass@example.test'), /credentials/);
  for (const bad of [[],[{address:'8.8.8.8',family:6}],[{address:'garbage',family:4}]]) {
    answers = bad; await assert.rejects(fetch('https://example.test'), /not public/);
  }
  assert.equal(calls.length, 0);
});
await test('all mixed DNS answers rejected independent of order', async () => {
  for (const bad of ['127.0.0.1', '10.0.0.1', '::1', '::ffff:10.0.0.1']) {
    const publicIp = { address:'8.8.8.8', family:4 }, privateIp = { address:bad, family:net.isIP(bad) };
    for (const mixed of [[publicIp,privateIp],[privateIp,publicIp]]) {
      answers = mixed; await assert.rejects(fetch('https://example.test'), /not public/);
    }
  }
  assert.equal(calls.length, 0);
});
await test('one resolution pinned with hostname and HTTPS identity retained', async () => {
  answers = () => lookups.length === 1 ? [{address:'8.8.8.8',family:4}] : [{address:'127.0.0.1',family:4}];
  fixtures = [{}]; const result = await fetch('https://article.example.test:8443/path?q=a');
  assert.equal(result.body, 'hello'); assert.equal(result.contentType, 'text/plain');
  assert.equal(lookups.length, 1); assert.equal(calls[0].destination.address, '8.8.8.8');
  assert.equal(calls[0].url, 'https://article.example.test:8443/path?q=a');
  assert.equal(calls[0].options.rejectUnauthorized, undefined);
});
await test('public literals including native IPv6 do not resolve', async () => {
  for (const url of ['http://8.8.8.8/a','https://[2606:4700:4700::1111]/a']) {
    fixtures.push({}); await fetch(url);
  }
  assert.equal(lookups.length, 0);
  assert.equal(calls[1].destination.address, '2606:4700:4700::1111');
});
await test('relative redirects close prior bodies and revalidate', async () => {
  fixtures = [{status:302,headers:{location:'/next'},hang:true},{}];
  assert.equal((await fetch('https://example.test/start')).finalUrl, 'https://example.test/next');
  assert.equal(lookups.length, 2);
});
await test('redirect to private, non-HTTP or rebinding answer is blocked', async () => {
  for (const location of ['http://127.0.0.1/','http://[::1]/','file:///tmp/a']) {
    fixtures.push({status:302,headers:{location},hang:true});
    await assert.rejects(fetch('https://example.test'), /not public|only http/);
  }
  answers = () => lookups.length === 4 ? [{address:'8.8.8.8',family:4}] : [{address:'10.0.0.1',family:4}];
  fixtures.push({status:302,headers:{location:'/again'},hang:true});
  await assert.rejects(fetch('https://example.test'), /not public/);
  assert.equal(calls.length, 4);
});
await test('redirect cap, missing location and HTTP failures close unread bodies', async () => {
  fixtures = Array.from({length:4}, () => ({status:302,headers:{location:'/loop'},hang:true}));
  await assert.rejects(fetch('https://example.test'), /too many redirects/);
  fixtures = [{status:301,headers:{},hang:true}]; await assert.rejects(fetch('https://example.test'), /without a destination/);
  fixtures = [{status:503,hang:true}]; await assert.rejects(fetch('https://example.test'), /HTTP 503/);
});
await test('exact cap succeeds, declared/chunked/false-length oversized bodies stop', async () => {
  fixtures = [{chunks:[Buffer.alloc(MAX)]}]; assert.equal((await fetch('https://example.test')).body.length, MAX);
  fixtures = [{headers:{'content-length':String(MAX+1)},hang:true}]; await assert.rejects(fetch('https://example.test'), /larger than 5MB/);
  for (const headers of [{},{'content-length':'1'}]) {
    fixtures = [{headers,chunks:[Buffer.alloc(MAX),Buffer.alloc(1)]}];
    await assert.rejects(fetch('https://example.test'), /larger than 5MB/);
  }
});
await test('gzip, deflate and brotli decode, with expansion caps', async () => {
  for (const [encoding,compress] of [['gzip',zlib.gzipSync],['deflate',zlib.deflateSync],['br',zlib.brotliCompressSync]]) {
    fixtures = [{headers:{'content-encoding':encoding},chunks:[compress(Buffer.from('article'))]}];
    assert.equal((await fetch('https://example.test')).body, 'article');
    fixtures = [{headers:{'content-encoding':encoding},chunks:[compress(Buffer.alloc(MAX+1))]}];
    await assert.rejects(fetch('https://example.test'), /larger than 5MB/);
  }
});
await test('bad encoding, compressed data and transport failures reject', async () => {
  fixtures = [{headers:{'content-encoding':'gzip, br'}}]; await assert.rejects(fetch('https://example.test'), /unsupported/);
  fixtures = [{headers:{'content-encoding':'gzip'},chunks:['bad compressed stream']}]; await assert.rejects(fetch('https://example.test'));
  fixtures = [{error:'connection failed'}]; await assert.rejects(fetch('https://example.test'), /connection failed/);
  fixtures = [{hang:true,broken:true}]; await assert.rejects(fetch('https://example.test'), /truncated/);
});
await test('deadline covers DNS, headers and streaming bodies', async () => {
  answers = () => new Promise(() => {}); await assert.rejects(fetch('https://example.test'), /timed out/);
  assert.equal(calls.length, 0); answers = [{address:'8.8.8.8',family:4}];
  fixtures = [{noHeaders:true}]; await assert.rejects(fetch('https://example.test'), /timed out/);
  fixtures = [{hang:true}]; await assert.rejects(fetch('https://example.test'), /timed out/);
});
await test('route denies unauthenticated/agent requests and failed fetches make no writes', async () => {
  const route = {}; let user = null, writes = 0, audited = 0;
  const deps = {
    'next/server': { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200 }) } },
    '@/lib/auth': { currentUser: async () => user },
    '@/lib/roles': { isAgent: value => value.role === 'agent', setSpaceMember: () => { writes++; } },
    '@/lib/data': {
      createSpace: () => { writes++; return { id:'s', slug:'imported', name:'Imported' }; },
      createPage: () => { writes++; return { id:'p' }; }, savePage: () => { writes++; },
    },
    '@/lib/markdown': { markdownToBlocks: () => [{type:'paragraph'}] },
    '@/lib/html-blocks': { pageContentToBlocks: () => ({title:'Article',blocks:[{type:'paragraph'}]}) },
    '@/lib/audit': { recordAudit: () => { audited++; } },
    '@/lib/import-url': { fetchGuarded: fetch },
  };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/api/import/url/route.ts', 'utf8'), {
    compilerOptions: { module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022 },
  }).outputText, { exports:route, URL, require: name => { assert.ok(name in deps, name); return deps[name]; } });
  const req = url => ({json:async () => ({url})});
  assert.equal((await route.POST(req('https://example.test'))).status, 401);
  user = {id:'u',role:'agent'};
  assert.equal((await route.POST(req('https://example.test'))).status, 403);
  user = {id:'u',role:'member'};
  assert.equal((await route.POST({json:async () => null})).status, 400);
  assert.equal((await route.POST(req('http://127.0.0.1'))).status, 400);
  fixtures = [{headers:{'content-length':String(MAX+1)},hang:true}];
  assert.equal((await route.POST(req('https://example.test'))).status, 400);
  assert.equal(writes, 0); assert.equal(audited, 0);
  fixtures = [{}]; const result = await route.POST(req('https://example.test'));
  assert.equal(result.status, 200); assert.equal(result.body.spaceSlug, 'imported');
  assert.equal(writes, 4); assert.equal(audited, 1);
});

await test('IPv6 exclusion boundaries and additional normalized URL variants', async () => {
  for (const ip of ['2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff', '2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff', '::ffff:0:127.0.0.1']) assert.equal(allowed(ip), false, ip);
  for (const url of ['http://127.0.0.1.', 'http://0x7f.1', 'http://%31%32%37.0.0.1', 'http://user@127.0.0.1', 'https://[fe80::1%25eth0]']) await assert.rejects(fetch(url));
  assert.equal(calls.length, 0);
});
await test('cross-host and scheme redirects validate newly pinned IPv6', async () => {
  answers = host => host === 'first.example.test' ? [{ address: '8.8.8.8', family: 4 }] : [{ address: '2606:4700:4700::1111', family: 6 }];
  fixtures = [{ status: 307, headers: { location: 'http://second.example.test:8080/article' }, hang: true }, {}];
  const result = await fetch('https://first.example.test/');
  assert.equal(result.finalUrl, 'http://second.example.test:8080/article');
  assert.deepEqual(lookups, ['first.example.test', 'second.example.test']);
  assert.equal(calls[1].destination.address, '2606:4700:4700::1111');
});
await test('cumulative deadline across redirects and late DNS never connects', async () => {
  answers = () => new Promise(resolve => setTimeout(() => resolve([{ address: '8.8.8.8', family: 4 }]), 90));
  fixtures = [{ status: 302, headers: { location: '/again' } }, {}];
  await assert.rejects(fetch('https://example.test'), /timed out/);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(calls.length, 1);
  assert.equal(lookups.length, 2);
});
await test('malformed declared lengths and compressed transfer limit', async () => {
  for (const length of ['-1', '5.5', 'abc', 'Infinity', '1e9', '999999999999999999999999']) {
    fixtures = [{ headers: { 'content-length': length }, hang: true }];
    await assert.rejects(fetch('https://example.test'), /invalid content length|larger/);
  }
  fixtures = [{ headers: { 'content-encoding': 'gzip' }, chunks: [zlib.gzipSync('a'), Buffer.alloc(MAX)] }];
  await assert.rejects(fetch('https://example.test'), /larger than 5MB/);
});
await test('DNS rejection propagates without connection or unhandled rejection', async () => {
  answers = () => Promise.reject(new Error('synthetic DNS error'));
  await assert.rejects(fetch('https://example.test'), /synthetic DNS error/);
  assert.equal(calls.length, 0);
  await new Promise(resolve => setImmediate(resolve));
});
await test('native Node request retains Host, SNI and pinned lookup options', async () => {
  // Exercise real Node request construction but substitute the Agent connection
  // with a Duplex: no DNS lookup, socket or TLS handshake is performed here.
  for (const [mod, raw, pin] of [
    [http, 'http://article.example.test:8080/a', '8.8.8.8'],
    [https, 'https://article.example.test:8443/a', '8.8.8.8'],
    [https, 'https://[2606:4700:4700::1111]/a', '2606:4700:4700::1111'],
  ]) {
    answers = [{ address: pin, family: net.isIP(pin) }];
    fixtures = [{}];
    await fetch(raw);
    const productionOptions = calls.at(-1).options;
    const original = mod.Agent.prototype.createConnection;
    let captured, req;
    mod.Agent.prototype.createConnection = function(options) {
      captured = options;
      return new stream.Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
    };
    try {
      const url = new URL(raw);
      req = mod.request(url, {
        ...productionOptions,
        // The completed synthetic fetch has aborted its original signal.
        signal: new AbortController().signal,
      }, () => {});
      req.on('error', () => {});
      req.end();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(req.getHeader('host'), url.host);
      assert.equal(captured.servername, net.isIP(pin) === 6 ? '' : url.hostname);
      assert.equal(captured.rejectUnauthorized, undefined);
      captured.lookup(captured.host, {}, (error, address, family) => {
        assert.equal(error, null);
        assert.equal(address, pin);
        assert.equal(family, net.isIP(pin));
      });
    } finally {
      req?.destroy();
      mod.Agent.prototype.createConnection = original;
    }
  }
});

console.log(`PASS ${count} safe URL import groups (synthetic, no network)`);
