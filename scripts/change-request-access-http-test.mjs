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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-access-http-'));
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
  const crs = require('../src/lib/change-requests.ts');
  const settings = require('../src/lib/settings.ts');
  const webhookLog = path.join(temporary, 'webhooks.jsonl');
  fs.writeFileSync(webhookLog, '');
  const hook = path.join(temporary, 'fetch-hook.cjs');
  fs.writeFileSync(hook, `const fs=require('node:fs'); globalThis.fetch=async (url,options)=>{if(String(url)!=='https://synthetic.invalid/review') throw new Error('Unexpected outbound fetch: '+url); fs.appendFileSync(${JSON.stringify(webhookLog)},options.body+'\\n'); return new Response('',{status:200});};`);
  settings.setSetting('webhook_url', 'https://synthetic.invalid/review');
  const newCr = f => crs.createChangeRequest({pageId:f.pages[1].id,authorId:'owner',title:`CR_${f.space.slug}_MARKER`,description:`DESCRIPTION_${f.space.slug}_MARKER`,proposedTitle:f.pages[1].title,proposedContent:JSON.stringify([{id:'proposal',type:'paragraph',content:[{type:'text',text:`PROPOSAL_${f.space.slug}_MARKER`,styles:{}}],children:[]}])});
  for(const f of fixtures) { f.draft={...f,pages:[f.pages[1],f.pages[0]]}; f.draft.cr=newCr(f.draft); f.cr=newCr(f); crs.reviewChangeRequest(f.cr.id,'editor','approve',`REVIEW_${f.space.slug}_MARKER`); }
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
  const actors = [null,'owner','editor','reader','outsider','agent','excluded','groupExcluded','groupAgent','admin'];
  const user = name => name ? {id:name,role:name==='agent'?'agent':name==='admin'?'admin':'member'} : null;
  const canonical = (f,cr=f.cr) => `/${f.space.slug}/${f.pages[1].slug}/changes/${cr.id}`;
  const sensitive = f => [f.pages[1].marker,`PROPOSAL_${f.space.slug}_MARKER`,`DESCRIPTION_${f.space.slug}_MARKER`,`REVIEW_${f.space.slug}_MARKER`];
  let checks=0;
  const view = async (url,who,allowed,markers) => {
    for(const rsc of [false,true]) {
      const response=await request(url+(rsc?'?_rsc':''),who,{headers:rsc?{RSC:'1'}:{}});
      const body=await response.text();
      if(allowed) {assert.equal(response.status,200,lastRequest); for(const marker of markers) assert.ok(body.includes(marker),`${lastRequest}: missing ${marker}`); assert.match(response.headers.get('cache-control')??'',/private/);}
      else {assert.ok(response.status>=300 || /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_REDIRECT;/.test(body),`${lastRequest}: missing denial`); for(const marker of markers) assert.ok(!body.includes(marker),`${lastRequest}: exposed ${marker}`);}
      checks++;
    }
  };
  for(const f of fixtures) for(const who of actors) {
    const read=roles.canReadSpace(user(who),f.space);
    await view(canonical(f),who,read,sensitive(f));
    await view(`/${f.space.slug}/${f.pages[1].slug}/propose`,who,!!who&&roles.may(user(who),f.space.id,'propose'),[f.pages[1].marker]);
    await view(`/${f.space.slug}/${f.pages[1].slug}/changes`,who,read,[f.cr.title]);
    const draft=f.draft, write=read && roles.canEditSpace(user(who),f.space.id);
    await view(canonical(draft),who,write,[draft.pages[1].marker,`PROPOSAL_${f.space.slug}_MARKER`,`DESCRIPTION_${f.space.slug}_MARKER`]);
    await view(`/${f.space.slug}/${draft.pages[1].slug}/changes`,who,write,[draft.cr.title]);
    await view(`/${f.space.slug}/${draft.pages[1].slug}/propose`,who,write,[draft.pages[1].marker]);
    for(const target of [f,draft]) {
      const before=snapshot(),webhooks=hooks();
      const response=await request('/api/change-requests',who,{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({pageId:target.pages[1].id,title:'HTTP API proposal',proposedContent:[]})});
      const allowed=!!who&&read&&roles.may(user(who),f.space.id,'propose')&&(target===f||write);
      assert.equal(response.status,allowed?200:who?403:401,lastRequest);
      const result=await response.json();
      if(allowed) assert.equal(crs.getChangeRequest(result.id).author_id,who);
      else {assert.equal(snapshot(),before,'denied API proposal changes no rows');assert.equal(hooks(),webhooks,'denied API proposal invokes no webhook');}
      checks++;
    }
    for(const slug of [f.pages[0].slug,'missing-page']) await view(`/${f.space.slug}/${slug}/changes/${f.cr.id}`,who,false,sensitive(f));
    for(const other of fixtures.filter(other=>other!==f)) await view(`/${other.space.slug}/${other.pages[1].slug}/changes/${f.cr.id}`,who,false,sensitive(f));
  }
  const post = async (url,who,actionId,values) => {
    const body=new FormData(); for(const [key,value] of Object.entries({[actionId]:'',...values})) body.set(key,String(value));
    const response=await request(url,who,{method:'POST',headers:{origin:base},body});
    await response.text(); assert.equal(response.status,303,lastRequest); checks++; return response;
  };
  for(const f of fixtures) {
    const response=await request(canonical(f),'reader');
    const markup=((await response.text()).match(/<form\b[\s\S]*?<\/form>/g)??[]).find(form=>form.includes('name="verdict"'));
    const actionId=markup?.match(/name="(\$ACTION_ID_[^"]+)"/)?.[1]; assert.ok(actionId,'Compiled review action reference');
    const deny=async(who,cr,extra={})=>{
      const before=snapshot(),webhooks=hooks();
      await post(canonical(f),who,actionId,{id:cr.id,space:f.space.slug,page:f.pages[1].slug,verdict:'changes',note:'DENIED_REVIEW',...extra});
      assert.equal(snapshot(),before,`${lastRequest}: denied review changed database`);assert.equal(hooks(),webhooks,'denied review invoked webhook');
    };
    for(const who of actors) {
      const allowed=!!who&&who!=='owner'&&roles.canReadSpace(user(who),f.space);
      const cr=newCr(f);
      for(const verdict of ['changes','approve']) {
        if(!allowed) await deny(who,cr,{verdict});
        else {
          const before=hooks().split('\n').filter(Boolean).length;
          const result=await post(canonical(f),who,actionId,{id:cr.id,space:'wrong-space',page:'wrong-page',verdict,note:'ALLOWED_REVIEW'});
          assert.equal(result.headers.get('location'),canonical(f,cr));
          const reviews=crs.listReviews(cr.id); assert.equal(reviews.length,1);assert.equal(reviews[0].verdict,verdict);
          const notification=db.prepare('SELECT * FROM notifications ORDER BY rowid DESC LIMIT 1').get();assert.equal(notification.url,canonical(f,cr));assert.equal(notification.space_id,f.space.id);
          assert.equal(hooks().split('\n').filter(Boolean).length,before+1,'one webhook per allowed review');
        }
      }
    }
    const draftCr=newCr(f.draft);
    for(const who of actors) {
      const allowed=!!who&&who!=='owner'&&roles.canReadSpace(user(who),f.space)&&roles.canEditSpace(user(who),f.space.id);
      if(!allowed) await deny(who,draftCr);
      else {
        await post(canonical(f),who,actionId,{id:draftCr.id,verdict:'approve'});
        assert.ok(crs.listReviews(draftCr.id).some(review=>review.user_id===who),'writer can review draft target');
      }
    }
    const cr=newCr(f);
    for(const who of ['reader','outsider']) {
      await deny(who,cr,{verdict:'invalid'});await deny(who,{id:'missing-cr'});
      for(const status of ['closed','merged']) {crs.setChangeRequestStatus(cr.id,status);await deny(who,cr);}
      crs.setChangeRequestStatus(cr.id,'open');
    }
    // Exercise the other compiled controls and retained-author access checks.
    const controls=newCr(f), controlUrl=canonical(f,controls);
    const originalUpdated=data.getPage(f.pages[1].id).updated_at;
    db.prepare('UPDATE pages SET updated_at=updated_at+1 WHERE id=?').run(f.pages[1].id);
    const controlResponse=await request(controlUrl,'owner');
    const controlForms=(await controlResponse.text()).match(/<form\b[\s\S]*?<\/form>/g)??[];
    const controlId=text=>controlForms.find(form=>form.includes(text))?.match(/name="(\$ACTION_ID_[^"]+)"/)?.[1];
    const closeId=controlId('name="status"'), rebaseId=controlId('Compare against the page'), mergeId=controlId('Merge into the page');
    assert.ok(closeId && rebaseId && mergeId,'Compiled close/rebase/merge action references');
    db.prepare('UPDATE pages SET updated_at=? WHERE id=?').run(originalUpdated,f.pages[1].id);
    await post(controlUrl,'reader',actionId,{id:controls.id,verdict:'changes'});
    const blocked=snapshot();
    await post(controlUrl,'editor',mergeId,{id:controls.id});
    assert.equal(snapshot(),blocked,'authorized reviewer objection prevents editor merge');
    await post(controlUrl,'reader',actionId,{id:controls.id,verdict:'approve'});
    const cannotMerge=snapshot();
    await post(controlUrl,'reader',mergeId,{id:controls.id});
    assert.equal(snapshot(),cannotMerge,'review does not grant merge permission');
    const mergeResponse=await post(controlUrl,'editor',mergeId,{id:controls.id,space:'wrong-space',page:'wrong-page'});
    assert.equal(crs.getChangeRequest(controls.id).status,'merged');
    assert.equal(mergeResponse.headers.get('location'),controlUrl);
    const former=newCr(f);
    if(f.space.tenant_id || f.space.visibility==='private') {
      roles.removeSpaceMember(f.space.id,'owner');
      if(f.space.tenant_id) tenants.removeMember(tenant.id,'owner');
      for(const control of [closeId,rebaseId,mergeId]) {
        const before=snapshot(),webhooks=hooks();
        await post(controlUrl,'owner',control,{id:former.id,status:'closed'});
        assert.equal(snapshot(),before,'former author cannot mutate inaccessible request');
        assert.equal(hooks(),webhooks,'former author cannot notify');
      }
      roles.setSpaceMember(f.space.id,'owner','admin');
      if(f.space.tenant_id) tenants.addMember(tenant.id,'owner');
    }
    // A reviewer retaining access must not send new proposal data to an author
    // whose target access has ended. Historical notifications are not rewritten.
    for(const draft of [false,true]) {
      const target=draft?f.draft:f;
      const recipientCr=newCr(target);
      const note=`FRESH_RECIPIENT_${f.space.slug}_${draft}_MARKER`;
      roles.setSpaceMember(f.space.id,'owner','reader');
      if(!draft) {
        roles.removeSpaceMember(f.space.id,'owner');
        if(f.space.tenant_id) {roles.setSpaceMember(f.space.id,'owner','admin');tenants.removeMember(tenant.id,'owner');}
      }
      const canReceive=!draft&&!f.space.tenant_id&&f.space.visibility==='public';
      const notifications=db.prepare('SELECT COUNT(*) n FROM notifications').get().n;
      const webhooks=hooks().split('\n').filter(Boolean).length;
      await post(canonical(f),'editor',actionId,{id:recipientCr.id,verdict:'approve',note});
      assert.equal(crs.listReviews(recipientCr.id)[0].note,note,'authorized review persists regardless of author access');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications').get().n,notifications+(canReceive?1:0),'notify only currently authorized author');
      assert.equal(hooks().split('\n').filter(Boolean).length,webhooks+(canReceive?1:0),'webhook only for authorized recipient');
      for(const rsc of [false,true]) {
        const inbox=await request(`/inbox${rsc?'?_rsc':''}`,'owner',{headers:rsc?{RSC:'1'}:{}});
        assert.equal(inbox.status,200); assert.equal((await inbox.text()).includes(note),canReceive,'inbox discloses no fresh note to revoked author'); checks++;
      }
      if(f.space.tenant_id) tenants.addMember(tenant.id,'owner');
      roles.setSpaceMember(f.space.id,'owner',draft?'editor':'reader');
      const permittedNote=note+'_RESTORED';
      const before=db.prepare('SELECT COUNT(*) n FROM notifications').get().n;
      const beforeHooks=hooks().split('\n').filter(Boolean).length;
      await post(canonical(f),'editor',actionId,{id:recipientCr.id,verdict:'changes',note:permittedNote});
      assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications').get().n,before+1,'published reader or draft writer author receives review');
      assert.equal(hooks().split('\n').filter(Boolean).length,beforeHooks+1);
      roles.setSpaceMember(f.space.id,'owner','admin');
    }
    data.deleteSpace(f.space.id,'owner');
    for(const who of [null,'reader','admin']) {await deny(who,cr); await view(canonical(f),who,false,sensitive(f));await view(`/${f.space.slug}/${f.pages[1].slug}/propose`,who,false,[f.pages[1].marker]);}
  }
  console.log(`Change-request compiled HTTP/RSC/form regression: ${checks} checks passed (isolated SQLite, real sessions, intercepted notification webhooks).`);
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
