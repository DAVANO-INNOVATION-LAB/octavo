// Real reading route, SQLite and sessions. Only framework request context is stubbed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, {createRequire} from 'node:module';
import ts from 'typescript';
import net from 'node:net';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
const require=createRequire(import.meta.url),root=path.resolve('src');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-reading-access-'));
process.env.OCTAVO_DATA_DIR=dir;
let cookie,db,server,checks=0;
const httpMode=process.argv.includes("--http");
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
const content=JSON.stringify([{id:'passage',type:'paragraph',content:[{type:'text',text:'Synthetic private passage with enough words to be a valid reading signal.',styles:{}}],children:[]}]);
try {
 db=load('lib/db.ts').getDb();
 const data=load('lib/data.ts'),roles=load('lib/roles.ts'),tenants=load('lib/tenants.ts'),settings=load('lib/settings.ts');
 const {NextRequest}=require('next/server');
 let route=load('app/api/reading/route.ts').POST;
 if(httpMode){
  assert.ok(fs.existsSync('.next/BUILD_ID'),'Build and postbuild must complete before HTTP tests');
  const socket=net.createServer().listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const base=`http://127.0.0.1:${port}`,log=fs.openSync(path.join(dir,'server.log'),'a');
  server=spawn(process.execPath,[path.resolve('.next/standalone/server.js')],{env:{...process.env,PORT:String(port),HOSTNAME:'127.0.0.1',OCTAVO_COLLAB:'0'},stdio:['ignore',log,log]});fs.closeSync(log);
  for(let i=0;;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}if(i>=100||server.exitCode!==null)throw Error(fs.readFileSync(path.join(dir,'server.log'),'utf8'));await new Promise(resolve=>setTimeout(resolve,100));}
  await (await import('./target.mjs')).requireTarget(base);
  route=async request=>fetch(base+'/api/reading',{method:'POST',headers:{'content-type':'application/json',...(cookie?{cookie:'octavo_session='+cookie}:{})},body:await request.text()});
 }
 const actors={};
 for(const id of ['owner','reader','outsider','admin','agent']){actors[id]={id,email:id+'@example.test',name:id,role:id==='admin'?'admin':id==='agent'?'agent':'member'};db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id,actors[id].email,id,'!',actors[id].role,Date.now());db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run('session-'+id,id,Date.now()+86400000);}
 const tenant=tenants.createTenant('Reading tenant');for(const who of ['owner','reader','agent'])tenants.addMember(tenant.id,who);
 const fixtures=[];
 for(const tenanted of [false,true])for(const visibility of ['public','private']){
  let space=data.createSpace({name:`${tenanted?'tenant':'library'} ${visibility}`,visibility});if(tenanted)tenants.setSpaceTenant(space.id,tenant.id);space=data.getSpace(space.id);
  for(const [who,role] of [['owner','admin'],['reader','reader'],['agent','agent']])roles.setSpaceMember(space.id,who,role);
  for(const published of [false,true])fixtures.push({space,page:data.createPage({spaceId:space.id,title:'Reading fixture',published,content})});
 }
 const post=(page,blocks=[{id:'passage',dwell:1200,revisits:1,exit:true}])=>route(new NextRequest('http://localhost/api/reading',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pageId:page.id,blocks})}));
 const rows=()=>db.prepare('SELECT * FROM reading_signals ORDER BY page_id,block_id').all();
 for(const {space,page} of fixtures)for(const actor of [null,...Object.keys(actors)]){
  cookie=actor?'session-'+actor:undefined;const user=actor?actors[actor]:null;
  const allowed=roles.canReadSpace(user,space)&&(!!page.published||roles.canEditSpace(user,space.id));
  db.prepare('DELETE FROM reading_signals').run();
  const response=await post(page);assert.equal(response.status,204);assert.equal(await response.text(),'');
  assert.equal(rows().length,Number(allowed),`${space.slug} published=${page.published} actor=${actor}: denied callers cannot poison draft analytics`);checks++;
 }
 const published=fixtures.find(f=>f.space.visibility==='public'&&!f.space.tenant_id&&f.page.published).page;
 cookie=undefined;db.prepare('DELETE FROM reading_signals').run();
 await post(published,Array.from({length:400},()=>({id:'passage',dwell:1e9,revisits:1e9,exit:true})));
 assert.equal(rows().length,1);assert.equal(rows()[0].views,1);assert.equal(rows()[0].dwell_ms,120000);assert.equal(rows()[0].revisits,50);assert.equal(rows()[0].exits,1);checks++;
 const before=JSON.stringify(rows());await post(published,[{id:'unknown',dwell:1234,exit:true}]);assert.equal(JSON.stringify(rows()),before);checks++;
 settings.setSetting('reading_signals','off');await post(published);assert.equal(JSON.stringify(rows()),before);checks++;settings.setSetting('reading_signals',null);
 const tenantPage=fixtures.find(f=>f.space.tenant_id&&f.page.published);tenants.removeMember(tenant.id,'owner');cookie='session-owner';await post(tenantPage.page);assert.equal(JSON.stringify(rows()),before);checks++;
 // An unpublished page with the same known block ID is not a new authorized visit.
 data.savePage(published.id,{published:false});cookie=undefined;await post(published);assert.equal(JSON.stringify(rows()),before);checks++;
 console.log(`${checks} reading authorization/integrity checks passed (${httpMode?"compiled HTTP":"source route"})`);
} finally {if(server&&server.exitCode===null){server.kill();await once(server,"exit");}Module._load=oldLoad;Module._extensions['.ts']=oldTs;if(db?.open)db.close();delete globalThis.__octavoDb;fs.rmSync(dir,{recursive:true,force:true});}
