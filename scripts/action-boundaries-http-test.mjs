// Compiled Next HTTP smoke. Run npm run build first. Uses an isolated database and loopback server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import Module, { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-action-http-'));
process.env.OCTAVO_DATA_DIR = path.join(temporary, 'data');
const originalLoad = Module._load, originalTs = Module._extensions['.ts'];
let db, server, logPath, lastRequest;
Module._load = function(name, parent, main) {
  if (name === 'server-only') return {};
  if (name === 'next/headers') return { cookies: async () => ({ get: () => undefined }) };
  return originalLoad.call(this, name, parent, main);
};
Module._extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, file);
try {
  assert.ok(fs.existsSync('.next/BUILD_ID'), 'Run npm run build first');
  db = require('../src/lib/db.ts').getDb();
  const data = require('../src/lib/data.ts'), roles = require('../src/lib/roles.ts'), tenants = require('../src/lib/tenants.ts');
  for (const name of ['owner', 'editor', 'reader', 'outsider', 'agent', 'excluded', 'groupExcluded', 'groupAgent', 'admin']) {
    db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(name, `${name}@example.test`, name, '!', name === 'agent' ? 'agent' : name === 'admin' ? 'admin' : 'member', Date.now());
    db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run(`synthetic-${name}`, name, Date.now() + 86400000);
  }
  const tenant = tenants.createTenant('HTTP tenant');
  tenants.addMember(tenant.id, 'owner'); tenants.addMember(tenant.id, 'reader'); tenants.addMember(tenant.id, 'agent'); tenants.addMember(tenant.id, 'editor'); tenants.addMember(tenant.id, 'groupAgent');
  const groups = require('../src/lib/groups.ts');
  const excludedGroup = groups.createGroup('Retained group'); groups.addGroupMember(excludedGroup.id, 'groupExcluded');
  const agentGroup = groups.createGroup('Agent group'); groups.addGroupMember(agentGroup.id, 'groupAgent');
  const fixtures = [];
  for (const [name, visibility, tenanted] of [['private', 'private', false], ['public', 'public', false], ['tenant', 'public', true], ['tenant-private', 'private', true]]) {
    let space = data.createSpace({ name: `HTTP ${name}`, visibility });
    if (tenanted) tenants.setSpaceTenant(space.id, tenant.id);
    for (const [who, role] of [['owner', 'admin'], ['reader', 'reader'], ['editor', 'editor'], ['agent', 'admin'], ['excluded', 'admin']]) roles.setSpaceMember(space.id, who, role);
    groups.setGroupGrant(excludedGroup.id, space.id, 'admin'); groups.setGroupGrant(agentGroup.id, space.id, 'agent');
    space = data.getSpace(space.id);
    const pages = [false, true].map(published => {
      const marker = `HTTP_${name}_${published ? 'PUBLISHED' : 'DRAFT'}_PRIVATE_MARKER`;
      const page = data.createPage({ spaceId: space.id, title: marker, published,
        content: JSON.stringify([{ id: marker, type: 'paragraph', content: [{ type: 'text', text: marker, styles: {} }], children: [] }]) });
      data.snapshotNow(page.id);
      return { ...page, marker, version: data.listVersions(page.id)[0].id };
    });
    fixtures.push({ space, pages });
  }
  const webhookLog = path.join(temporary, 'webhooks.jsonl');
  fs.writeFileSync(webhookLog, '');
  const hook = path.join(temporary, 'fetch-hook.cjs');
  fs.writeFileSync(hook, `const fs=require('node:fs'); globalThis.fetch=async (url,options)=>{if(String(url)!=='https://synthetic.invalid/actions') throw new Error('Unexpected outbound fetch: '+url); fs.appendFileSync(${JSON.stringify(webhookLog)},options.body+'\\n'); return new Response('',{status:200});};`);
  require('../src/lib/settings.ts').setSetting('webhook_url', 'https://synthetic.invalid/actions');
  const visitors = require('../src/lib/visitors.ts');
  for(const f of fixtures) {
    f.root = data.addComment(f.pages[1].id, 'owner', 'Synthetic root');
    f.token = visitors.createVisitorToken({spaceId:f.space.id,label:'Synthetic visitor',days:1,createdBy:'owner'}).row;
  }
  const socket = net.createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening'); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  logPath = path.join(temporary, 'server.log');
  const log = fs.openSync(logPath, 'a');
  server = spawn(process.execPath, ['--require',hook,path.resolve('.next/standalone/server.js')], {
    cwd: process.cwd(), env: { ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1', OCTAVO_COLLAB: '0' }, stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (attempt >= 100 || server.exitCode !== null) throw new Error(`Test server failed: ${fs.readFileSync(logPath, 'utf8')}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const { requireTarget } = await import('./target.mjs');
  await requireTarget(base);
  const request = (url, who, options = {}) => {
    lastRequest = `${options.method ?? 'GET'} ${url} actor=${who ?? 'anonymous'}`;
    return fetch(`${base}${url}`, { redirect: 'manual', ...options,
      headers: { connection: 'close', ...(who ? { cookie: `octavo_session=synthetic-${who}` } : {}), ...options.headers } });
  };
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
  const snapshot = () => JSON.stringify(tables.map(table=>[table,db.prepare(`SELECT * FROM "${table}"`).all().map(row=>JSON.stringify(row)).sort()]));
  const hooks = () => fs.readFileSync(webhookLog,'utf8');
  let checks = 0;
  const forms = async (url,who='owner') => {
    const response = await request(url,who);
    assert.equal(response.status,200,lastRequest);
    return (await response.text()).match(/<form\b[\s\S]*?<\/form>/g)??[];
  };
  const action = (forms, marker) => {
    const id = forms.find(form=>form.includes(marker))?.match(/name="(\$ACTION_ID_[^"]+)"/)?.[1];
    assert.ok(id,`Compiled action reference: ${marker}`); return id;
  };
  const post = async (url,who,id,values) => {
    const body=new FormData(); for(const [key,value] of Object.entries({[id]:'',...values})) body.set(key,String(value));
    const response=await request(url,who,{method:'POST',headers:{origin:base},body});
    await response.text(); assert.equal(response.status,303,lastRequest); checks++; return response;
  };
  const deny = async (url,who,id,values) => {
    const before=snapshot(),webhooks=hooks(); await post(url,who,id,values);
    assert.equal(snapshot(),before,`${lastRequest}: denied action changed rows`);
    assert.equal(hooks(),webhooks,`${lastRequest}: denied action notified`);
  };
  const actors=[null,'owner','editor','reader','outsider','agent','excluded','groupExcluded','groupAgent','admin'];
  const user=who=>who?{id:who,role:who==='agent'?'agent':who==='admin'?'admin':'member'}:null;
  const revokeAction=action(await forms(`/${fixtures[0].space.slug}/members`),'Revoke');
  for(const f of fixtures) {
    const page=f.pages[1],url=`/${f.space.slug}/${page.slug}`;
    const controls=await forms(url);
    const add=action(controls,'Post comment'),remove=action(controls,'Delete comment'),resolve=action(controls,'name="resolved"');
    const values={pageId:page.id,space:'forged-space',page:'forged-page'};
    for(const target of f.pages) for(const who of actors) {
      const allowed=!!who&&roles.canReadSpace(user(who),f.space)&&roles.may(user(who),f.space.id,'comment')&&(target.published===1||roles.canEditSpace(user(who),f.space.id));
      const input={...values,pageId:target.id,body:`Synthetic ${who} ${target.id}`};
      if(!allowed) await deny(url,who,add,input);
      else {
        const response=await post(url,who,add,input);
        const row=db.prepare('SELECT * FROM comments WHERE body=?').get(input.body);
        assert.equal(row.user_id,who); assert.equal(row.page_id,target.id);
        assert.equal(response.headers.get('location'),`/${f.space.slug}/${target.slug}#t-${row.id}`);
        await post(url,who,resolve,{...values,pageId:target.id,id:row.id,resolved:'1'});
        assert.ok(db.prepare('SELECT resolved_at FROM comments WHERE id=?').get(row.id).resolved_at);
        await post(url,who,remove,{...values,pageId:target.id,id:row.id}); assert.equal(data.getComment(row.id),null);
      }
    }
    for(const who of ['reader','editor','outsider','agent']) for(const id of [remove,resolve])
      await deny(url,who,id,{...values,id:f.root,resolved:'1'});
    const other=fixtures.find(other=>other!==f);
    for(const id of [remove,resolve]) await deny(url,'owner',id,{...values,id:other.root,resolved:'1'});
    for(const parentId of ['missing-comment',other.root]) await deny(url,'owner',add,{...values,parentId,body:'@reader denied'});
    await deny(url,'owner',add,{...values,body:'  '});
    await deny(url,'owner',add,{...values,pageId:'missing-page',body:'@reader denied'});
    const before=db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=?').get('outsider').n;
    await post(url,'editor',add,{...values,body:'@outsider private comment'});
    const outsiderCanRead=roles.canReadSpace(user('outsider'),f.space);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=?').get('outsider').n,before+(outsiderCanRead?1:0));
    // Replies canonicalize to the persisted root, and new notifications require current access.
    const reply=data.addComment(page.id,'reader','Synthetic reply',{parentId:f.root});
    const response=await post(url,'editor',add,{...values,parentId:reply,body:'Nested HTTP reply'});
    assert.equal(response.headers.get('location'),`${url}#t-${f.root}`);
    for(const id of [remove,resolve]) {
      if(id===resolve) await deny(url,'reader',id,{...values,id:reply,resolved:'1'});
    }
    if(f.space.visibility==='private'||f.space.tenant_id) {
      roles.removeSpaceMember(f.space.id,'owner'); if(f.space.tenant_id) tenants.removeMember(tenant.id,'owner');
      for(const id of [remove,resolve]) await deny(url,'owner',id,{...values,id:f.root,resolved:'1'});
      const notifications=db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=?').get('owner').n;
      await post(url,'editor',add,{...values,parentId:f.root,body:'@owner revoked recipient marker'});
      assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=?').get('owner').n,notifications);
      if(f.space.tenant_id) tenants.addMember(tenant.id,'owner'); roles.setSpaceMember(f.space.id,'owner','admin');
    }
    const members=`/${f.space.slug}/members`,revoke=revokeAction;
    for(const who of [null,'reader','editor','outsider','agent','groupAgent']) await deny(members,who,revoke,{space:f.space.slug,id:f.token.id});
    await deny(members,'owner',revoke,{space:f.space.slug,id:other.token.id});
    await deny(members,'owner',revoke,{space:f.space.slug,id:'missing-token'});
    await post(members,'owner',revoke,{space:f.space.slug,id:f.token.id});
    assert.ok(db.prepare('SELECT revoked_at FROM visitor_tokens WHERE id=?').get(f.token.id).revoked_at);
    await deny(members,'owner',revoke,{space:f.space.slug,id:f.token.id});
    const createPage=action(await forms(`/${f.space.slug}`),'New page');
    for(const who of [null,'reader','outsider','agent','groupAgent']) await deny(url,who,createPage,{space:f.space.slug});
    for(const parentId of ['missing-page',other.pages[1].id]) await deny(url,'owner',createPage,{space:f.space.slug,parentId});
    const existing=db.prepare('SELECT COUNT(*) n FROM pages WHERE space_id=?').get(f.space.id).n;
    await post(url,'owner',createPage,{space:f.space.slug,parentId:page.id});
    assert.equal(db.prepare('SELECT COUNT(*) n FROM pages WHERE space_id=?').get(f.space.id).n,existing+1);
    assert.ok(db.prepare('SELECT id FROM pages WHERE parent_id=?').get(page.id));
  }
  const createSpace=action(await forms('/new'),'name="name"');
  for(const who of [null,'agent']) await deny('/new',who,createSpace,{name:'Denied new space',visibility:'private',template:'blank'});
  const before=db.prepare('SELECT COUNT(*) n FROM spaces').get().n;
  await post('/new','owner',createSpace,{name:'Allowed HTTP space',visibility:'private',template:'blank'});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM spaces').get().n,before+1);
  console.log(`Action-boundary compiled HTTP regression: ${checks} checks passed (isolated SQLite, real sessions, notification interception).`);
} catch(error) {
  console.error(`HTTP fixture failed at ${lastRequest}; server exit=${server?.exitCode}`);
  if(logPath && fs.existsSync(logPath)) console.error(fs.readFileSync(logPath,'utf8').slice(-6000));
  throw error;
} finally {
  if(server && server.exitCode===null) {server.kill('SIGTERM');await once(server,'exit');}
  db?.close(); Module._load=originalLoad;
  if(originalTs) Module._extensions['.ts']=originalTs; else delete Module._extensions['.ts'];
  fs.rmSync(temporary,{recursive:true,force:true});
}
