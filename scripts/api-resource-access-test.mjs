// Real API exports, SQLite and authorization; synthetic users/files only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, {createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),root=path.resolve('src');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-api-resource-'));
process.env.OCTAVO_DATA_DIR=dir;
let cookie,db,checks=0;
const oldLoad=Module._load,oldTs=Module._extensions['.ts'];
Module._load=function(name,parent,main){
 if(name==='server-only')return {};
 if(name==='next/headers')return {cookies:async()=>({get:n=>n==='octavo_session'&&cookie?{value:cookie}:undefined}),headers:async()=>new Map()};
 if(name==='next/cache')return {revalidatePath:()=>{}};
 if(name.startsWith('@/'))name=path.join(root,name.slice(2));
 return oldLoad.call(this,name,parent,main);
};
Module._extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const load=n=>require(path.join(root,n));
const content=text=>JSON.stringify([{id:'block',type:'paragraph',content:[{type:'text',text,styles:{}}],children:[]}]);
try {
 const dbm=load('lib/db.ts');db=dbm.getDb();
 const data=load('lib/data.ts'),roles=load('lib/roles.ts'),tenants=load('lib/tenants.ts'),uploads=load('lib/uploads.ts');
 const {NextRequest}=require('next/server');
 const actors={};
 for(const id of ['owner','reader','outsider','admin']){actors[id]={id,email:id+'@example.test',name:id,role:id==='admin'?'admin':'member'};db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id,actors[id].email,id,'!',actors[id].role,Date.now());db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run('session-'+id,id,Date.now()+86400000);}
 const tenant=tenants.createTenant('Resource tenant');tenants.addMember(tenant.id,'owner');tenants.addMember(tenant.id,'reader');
 const exportRoute=load('app/api/pages/[id]/export/route.ts').GET, fileRoute=load('app/api/files/[name]/route.ts').GET, feedbackRoute=load('app/api/feedback/route.ts').POST,modelRoute=load('app/api/spaces/[slug]/model/route.ts').GET;
 const fixtures=[];
 for(const tenanted of [false,true])for(const visibility of ['public','private']){
  let space=data.createSpace({name:`${tenanted?'tenant':'library'} ${visibility}`,visibility});if(tenanted)tenants.setSpaceTenant(space.id,tenant.id);space=data.getSpace(space.id);
  roles.setSpaceMember(space.id,'owner','admin');roles.setSpaceMember(space.id,'reader','reader');
  const published=data.createPage({spaceId:space.id,title:'Published',published:true,content:content('PUBLISHED_SENTINEL')});
  const draft=data.createPage({spaceId:space.id,title:'Draft',published:false,content:content('DRAFT_SENTINEL')});
  fixtures.push({space,published,draft,tenanted});
 }
 const fetchFile=async(name,range)=>{const response=await fileRoute(new NextRequest('http://localhost/api/files/'+name,{headers:range?{range}:{}}),{params:Promise.resolve({name})});await response.arrayBuffer();return response;};
 for(const f of fixtures)for(const actor of [null,...Object.keys(actors)]){
  cookie=actor?'session-'+actor:undefined;const user=actor?actors[actor]:null;
  for(const [key,page] of [['published',f.published],['draft',f.draft]]){
   const expected=roles.canReadSpace(user,f.space)&&(key==='published'||roles.canEditSpace(user,f.space.id));
   const r=await exportRoute(new NextRequest('http://localhost/export'),{params:Promise.resolve({id:page.id})});assert.equal(r.status===200,expected,`export ${f.space.slug}/${key}/${actor}`);const b=await r.text();if(!expected)assert.ok(!b.includes('SENTINEL'));else assert.equal(r.headers.get('cache-control'),'private, no-store');checks++;
   const before=db.prepare('SELECT COUNT(*) n FROM feedback').get().n;
   const fr=await feedbackRoute(new NextRequest('http://localhost/api/feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pageId:page.id,helpful:false,note:'fixture'})}));
   const feedbackAllowed=key==='published'&&roles.canReadSpace(user,f.space);assert.equal(fr.status===200,feedbackAllowed);assert.equal(db.prepare('SELECT COUNT(*) n FROM feedback').get().n,before+Number(feedbackAllowed));checks++;
  }
 }
 const source=fixtures.find(f=>f.tenanted&&f.space.visibility==='private'),publicSpace=fixtures.find(f=>!f.tenanted&&f.space.visibility==='public');
 const name='protected123.csv';fs.writeFileSync(path.join(dbm.UPLOADS_DIR,name),'x,y,z,label\n1,2,3,PRIVATE_FILE_POINT\n');uploads.recordUpload(name,'owner',source.space.id);
 data.savePage(source.published.id,{content:content('/api/files/'+name)});
 // A pasted name in a public space cannot change canonical origin authority.
 data.savePage(publicSpace.published.id,{content:content('/api/files/'+name)});
 for(const actor of [null,'outsider','owner','reader','admin']){
  cookie=actor?'session-'+actor:undefined;const permitted=['owner','reader','admin'].includes(actor);
  for(const range of [undefined,'bytes=0-3']){const r=await fetchFile(name,range);assert.equal(r.status,permitted?(range?206:200):404);if(permitted){assert.equal(r.headers.get('cache-control'),'private, no-store');assert.equal(r.headers.get('vary'),'Cookie');}checks++;}
  const r=await modelRoute(new NextRequest('http://localhost/model?source=data&data='+name),{params:Promise.resolve({slug:publicSpace.space.slug})});assert.equal(r.status,permitted?200:404);const b=await r.text();assert.equal(b.includes('PRIVATE_FILE_POINT'),permitted);checks++;
 }
 // Draft-only origin, origin unpublishing and removed tenant membership fail closed.
 data.savePage(source.published.id,{published:false});cookie='session-reader';assert.equal(uploads.canReadUpload(actors.reader,name),false);checks++;
 cookie='session-owner';assert.equal(uploads.canReadUpload(actors.owner,name),true);checks++;
 tenants.removeMember(tenant.id,'owner');assert.equal(uploads.canReadUpload(actors.owner,name),false);checks++;
 const publicDraftName='draft123.txt';fs.writeFileSync(path.join(dbm.UPLOADS_DIR,publicDraftName),'DRAFT_ATTACHMENT');uploads.recordUpload(publicDraftName,'owner',publicSpace.space.id);data.savePage(publicSpace.draft.id,{content:content('/api/files/'+publicDraftName)});
 cookie=undefined;assert.equal((await fetchFile(publicDraftName)).status,404);checks++;
 data.savePage(publicSpace.draft.id,{published:true});assert.equal((await fetchFile(publicDraftName)).status,200);checks++;
 data.savePage(publicSpace.draft.id,{content:content('removed')});assert.equal((await fetchFile(publicDraftName)).status,404);checks++;
 // Covers count as current references, but historical body references do not.
 db.prepare('UPDATE pages SET cover=? WHERE id=?').run('/api/files/'+publicDraftName,publicSpace.published.id);assert.equal((await fetchFile(publicDraftName)).status,200);checks++;
 // Bare structured model filenames remain valid publication references.
 const bare='bare_model.csv';fs.writeFileSync(path.join(dbm.UPLOADS_DIR,bare),'x,y,z,label\n1,2,3,BARE_POINT\n');uploads.recordUpload(bare,'owner',publicSpace.space.id);
 data.savePage(publicSpace.published.id,{content:JSON.stringify([{id:'model',type:'model3d',props:{source:'data',dataUrl:bare},children:[]}])});
 assert.equal(uploads.canReadUpload(null,bare),true);assert.ok(JSON.stringify(load('lib/model-source.ts').dataScene(bare,'',null)).includes('BARE_POINT'));checks+=2;
 // Legacy references never invent provenance, even with multiple references.
 const legacy='legacy123.txt';fs.writeFileSync(path.join(dbm.UPLOADS_DIR,legacy),'LEGACY_BYTES');
 data.savePage(publicSpace.published.id,{content:content('/api/files/'+legacy)});uploads.syncUploadRefs(source.space.id,content('/api/files/'+legacy));
 for(const actor of [null,actors.owner,actors.reader,actors.outsider]){assert.equal(uploads.canReadUpload(actor,legacy),false);checks++;}
 assert.equal(uploads.canReadUpload(actors.admin,legacy),true);assert.equal(fs.readFileSync(path.join(dbm.UPLOADS_DIR,legacy),'utf8'),'LEGACY_BYTES');checks+=2;
 // Unplaced uploader preview does not grant another caller access.
 uploads.recordUpload('unplaced123.txt','owner',null);assert.equal(uploads.canReadUpload(actors.owner,'unplaced123.txt'),true);assert.equal(uploads.canReadUpload(actors.outsider,'unplaced123.txt'),false);checks++;
 // Published architecture must not disclose draft or other-space parent titles.
 const model=load('lib/model-source.ts');const parent=data.createPage({spaceId:publicSpace.space.id,title:'HIDDEN_PARENT',published:false});data.createPage({spaceId:publicSpace.space.id,parentId:parent.id,title:'Visible child',published:true});assert.ok(!JSON.stringify(model.architectureScene(publicSpace.space.id)).includes('HIDDEN_PARENT'));checks++;
 const bundle=load('lib/release-bundle.ts');assert.throws(()=>bundle.releaseBundle(actors.outsider,publicSpace.space,'fixture'));checks++;
 roles.setSpaceMember(publicSpace.space.id,'outsider','editor');data.savePage(publicSpace.published.id,{content:JSON.stringify([{id:'image',type:'image',props:{url:'/api/files/'+name},children:[]}])});assert.throws(()=>bundle.releaseBundle(actors.outsider,publicSpace.space,'fixture'),/attachment is inaccessible/);checks++;
 console.log(`${checks} API resource-access checks passed`);
} finally {Module._load=oldLoad;Module._extensions['.ts']=oldTs;if(db?.open)db.close();delete globalThis.__octavoDb;fs.rmSync(dir,{recursive:true,force:true});}
