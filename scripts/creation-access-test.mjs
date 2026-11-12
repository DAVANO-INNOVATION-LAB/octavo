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
try {
 db=load('lib/db.ts').getDb();const actions=load('app/actions.ts'),data=load('lib/data.ts'),roles=load('lib/roles.ts');
 for(const name of ['agent','owner','outsider','reader']){
 db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(name,name+'@example.test',name,'!',name==='agent'?'agent':'member',Date.now());
 db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run('synthetic-'+name,name,Date.now()+86400000);}
 const own=data.createSpace({name:'Own',visibility:'private'}),foreign=data.createSpace({name:'Foreign',visibility:'private'});roles.setSpaceMember(own.id,'owner','admin');roles.setSpaceMember(own.id,'reader','reader');
 const parent=data.createPage({spaceId:own.id,title:'Valid parent'}),other=data.createPage({spaceId:foreign.id,title:'Foreign parent'});
 const snapshot=()=>JSON.stringify(['spaces','pages','space_members','audit_log'].map(t=>db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()));
 for(const actor of [null,'agent']) {cookie=actor?'synthetic-'+actor:undefined;const before=snapshot();await call(()=>actions.createSpaceAction(form({name:'Forbidden',template:'blank'})));assert.equal(snapshot(),before);checks++;}
 cookie='synthetic-owner';await call(()=>actions.createSpaceAction(form({name:'Allowed',template:'blank'})));assert.ok(data.getSpaceBySlug('allowed'));checks++;
 for(const actor of [null,'agent','reader','outsider','owner']) for(const parentId of ['',parent.id,other.id,'missing']){
 cookie=actor?'synthetic-'+actor:undefined;const before=snapshot(),count=db.prepare('SELECT count(*) n FROM pages').get().n;
 await call(()=>actions.createPageAction(form({space:own.slug,parentId})));
 if(actor==='owner'&&['',parent.id].includes(parentId))assert.equal(db.prepare('SELECT count(*) n FROM pages').get().n,count+1);
 else assert.equal(snapshot(),before,actor+'/'+parentId);checks++;
 }
 console.log('Creation boundaries '+checks+' checks passed');
} finally {globalThis.fetch=originalFetch;Module._load=originalLoad;Module._extensions['.ts']=originalTs;Module._extensions['.tsx']=originalTsx;db?.close();fs.rmSync(temporary,{recursive:true,force:true});}
