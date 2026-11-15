// Launch the actual documented npm commands against synthetic SQLite data.
// Requires an up-to-date production build for npm start; --only=dev is independent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import Module,{createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),root=process.cwd(),temp=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-cli-smoke-'));
const originalLoad=Module._load,originalTs=Module._extensions['.ts'];
process.env.OCTAVO_DATA_DIR=temp;
Module._load=function(n,p,m){
 if(n==='server-only')return {};
 if(n==='next/headers')return {cookies:async()=>({get:()=>undefined}),headers:async()=>new Map()};
 if(n==='./audit-forward')return {forwardAudit:()=>{}};
 if(n.startsWith('@/'))n=path.join(root,'src',n.slice(2));
 return originalLoad.call(this,n,p,m);
};
Module._extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
let db,child,checks=0;
const check=(name,value)=>{assert.ok(value,name);console.log('ok '+(++checks)+': '+name);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function stop(){
 if(!child)return;const current=child;child=null;
 if(current.exitCode!==null)return;
 const ended=once(current,'exit');
 process.kill(-current.pid,'SIGTERM');
 await Promise.race([ended,sleep(5000)]);
 if(current.exitCode===null){try{process.kill(-current.pid,'SIGKILL');}catch{}await ended;}
}
try{
 db=require('../src/lib/db.ts').getDb();
 const data=require('../src/lib/data.ts'),versions=require('../src/lib/page-revisions.ts');
 db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run('cli-admin','cli@example.test','CLI fixture','!','admin',Date.now());
 db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run('cli-synthetic-session','cli-admin',Date.now()+3600000);
 const space=data.createSpace({name:'CLI synthetic fixture',visibility:'private'});
 const only=process.argv.find(a=>a.startsWith('--only='))?.split('=')[1];
 for(const mode of only?[only]:['start','dev']){
  assert.ok(['start','dev'].includes(mode));
  const page=data.createPage({spaceId:space.id,title:mode+' original'});
  // Existing collaboration state must not block explicit single-writer mode.
  db.prepare('INSERT INTO collab_docs(page_id,state,updated_at) VALUES(?,?,?)').run(page.id,Buffer.alloc(0),Date.now());
  const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
  const args=['run',mode,'--','--hostname','127.0.0.1','--port',String(port),...(mode==='dev'?['--webpack']:[])];
  let output='';
  child=spawn('npm',args,{cwd:root,detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,OCTAVO_DATA_DIR:temp,OCTAVO_COLLAB:'1',OCTAVO_COLLAB_PERSISTENCE:'1',OCTAVO_COLLAB_INTERNAL_SECRET:'untrusted-smoke-secret',NEXT_TELEMETRY_DISABLED:'1'}});
  child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
  const base='http://127.0.0.1:'+port,headers={cookie:'octavo_session=cli-synthetic-session','content-type':'application/json'};
  let response;
  const deadline=Date.now()+180000;
  while(Date.now()<deadline){
   if(child.exitCode!==null)throw Error(mode+' exited: '+output);
   try{response=await fetch(base+'/api/collab/authorize?page='+page.id+'&claim=1',{headers,signal:AbortSignal.timeout(20000)});break;}catch{await sleep(250);}
  }
  assert.ok(response,mode+' became ready: '+output);
  check(mode+' announces single-writer mode',output.includes('single-writer mode'));
  assert.equal(response.status,503,mode+' collaboration disabled: '+await response.text());
  check(mode+' returns disabled503 for authenticated collaboration seeding',true);
  const version=versions.pageRevision(page.id);
  const content=[{id:'cli-body',type:'paragraph',content:[{type:'text',text:mode+' versioned body',styles:{}}],children:[]}];
  const payload={content,expectedRevision:version.revision,expectedEpoch:version.epoch};
  const saved=await fetch(base+'/api/pages/'+page.id,{method:'PATCH',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(60000)});
  assert.equal(saved.status,200,mode+' PATCH: '+await saved.clone().text());
  const result=await saved.json();
  check(mode+' persists authenticated versioned page-body edit',data.getPage(page.id).content.includes(mode+' versioned body')&&result.revision>version.revision);
  const stale=await fetch(base+'/api/pages/'+page.id,{method:'PATCH',headers,body:JSON.stringify({...payload,content:[]})});
  check(mode+' rejects stale version without erasing page',stale.status===409&&data.getPage(page.id).content.includes(mode+' versioned body'));
  await stop();
 }
 console.log(checks+' actual npm CLI launch checks passed');
}finally{
 await stop();db?.close();delete globalThis.__octavoDb;
 Module._load=originalLoad;Module._extensions['.ts']=originalTs;
 fs.rmSync(temp,{recursive:true,force:true});
}
