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
 db=load('lib/db.ts').getDb();
 const data=load('lib/data.ts'),roles=load('lib/roles.ts'),actions=load('app/actions.ts'),crs=load('lib/change-requests.ts'),tenants=load('lib/tenants.ts');
 for(const name of ['author','editor','outsider','agent']) {
 db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(name,name+'@example.test',name,'!',name==='agent'?'agent':'member',Date.now());
 db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run('synthetic-'+name,name,Date.now()+86400000);
 }
 const tenant=tenants.createTenant('Target tenant');tenants.addMember(tenant.id,'author');tenants.addMember(tenant.id,'editor');
 let space=data.createSpace({name:'Target',visibility:'private'});tenants.setSpaceTenant(space.id,tenant.id);space=data.getSpace(space.id);
 roles.setSpaceMember(space.id,'author','admin');roles.setSpaceMember(space.id,'editor','editor');roles.setSpaceMember(space.id,'outsider','admin');
 const page=data.createPage({spaceId:space.id,title:'Private page',published:true});
 cookie='synthetic-author';
 await call(()=>actions.createChangeRequestAction(form({pageId:page.id,title:'SECRET_NEW',proposedContent:'[]'})));
 assert.equal(db.prepare("SELECT count(*) n FROM notifications WHERE user_id='outsider'").get().n,0);
 assert.equal(db.prepare("SELECT count(*) n FROM notifications WHERE user_id='editor'").get().n,1);checks+=2;
 for(const operation of ['close','merge']) for(const access of [true,false]) {
 if(access)tenants.addMember(tenant.id,'author');else tenants.removeMember(tenant.id,'author');
 const cr=crs.createChangeRequest({pageId:page.id,authorId:'author',title:'PRIVATE_PROPOSAL',proposedTitle:'Proposed',proposedContent:'[]'});
 cookie='synthetic-editor'; roles.setSpaceMember(space.id,'editor','admin');
 const before=db.prepare("SELECT count(*) n FROM notifications WHERE user_id='author'").get().n;
 await call(()=>operation==='close'?actions.setChangeRequestStatusAction(form({id:cr.id,status:'closed'})):actions.mergeChangeRequestAction(form({id:cr.id})));
 assert.equal(db.prepare("SELECT count(*) n FROM notifications WHERE user_id='author'").get().n-before,access?1:0,operation+' access='+access);checks++;
 }
 console.log('Notification access '+checks+' checks passed');
} finally { globalThis.fetch=originalFetch;Module._load=originalLoad;Module._extensions['.ts']=originalTs;Module._extensions['.tsx']=originalTsx;db?.close();fs.rmSync(temporary,{recursive:true,force:true}); }
