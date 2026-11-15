// Actual SQLite/routes + real ESM BlockNote projector. Synthetic actor and data only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
const require=createRequire(import.meta.url),temp=fs.mkdtempSync(path.join(os.tmpdir(),'octavo-commit-')),root=path.resolve('src');
process.env.OCTAVO_DATA_DIR=path.join(temp,'data');delete process.env.OCTAVO_COLLAB_PERSISTENCE;delete process.env.OCTAVO_COLLAB;process.env.OCTAVO_COLLAB_INTERNAL_SECRET='synthetic-internal';
fs.symlinkSync(path.resolve('node_modules'),path.join(temp,'node_modules'),'dir');
for(const name of ['collab-schema','collab-projection'])fs.writeFileSync(path.join(temp,name+'.mjs'),ts.transpileModule(fs.readFileSync('src/lib/'+name+'.ts','utf8').replace('import "server-only";','').replace('"./collab-schema"','"./collab-schema.mjs"'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);
const projector=await import(pathToFileURL(path.join(temp,'collab-projection.mjs')));
const originalLoad=Module._load,originalTs=Module._extensions['.ts'];let db,user={id:'actor',name:'Actor',email:'actor@example.test',role:'admin'};
Module._load=function(n,p,m){if(n==='server-only')return {};if(n==='./collab-projection'||n==='@/lib/collab-projection')return projector;if(n==='@/lib/auth')return {currentUser:async()=>user};if(n==='next/headers')return {cookies:async()=>({get:()=>undefined}),headers:async()=>new Map()};if(n==='./audit-forward')return {forwardAudit:()=>{}};if(n.startsWith('@/'))n=path.join(root,n.slice(2));return originalLoad.call(this,n,p,m);};
Module._extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const http=require('node:http'),Y=require('yjs'),{WebSocket}=require('ws');
const encoding=require('lib0/encoding'),decoding=require('lib0/decoding'),sync=require('y-protocols/sync');
process.env.OCTAVO_COLLAB_INTERNAL_SECRET='synthetic-internal-secret-at-least-32-chars';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn)=>{for(let i=0;i<500;i++){if(fn())return;await wait(10);}throw Error('timed out');};
let checks=0,server,delayNext=false,held=null,dropNext=false,dropped=null;const clients=[],commitBodies=[];
const check=(name,value)=>{assert.ok(value,name);console.log('ok',++checks,name);};
try {
 db=require('../src/lib/db.ts').getDb();
 const data=require('../src/lib/data.ts'),revisions=require('../src/lib/page-revisions.ts'),route=require('../src/app/api/collab/commit/route.ts'),authorize=require('../src/app/api/collab/authorize/route.ts'),{NextRequest}=require('next/server');
 db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(user.id,user.email,user.name,'!',user.role,Date.now());
 db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run('actor-b','b@example.test','Actor B','!','admin',Date.now());
 const space=data.createSpace({name:'Websocket fixture',visibility:'private'});
 const page=data.createPage({spaceId:space.id,title:'Initial metadata',content:JSON.stringify([{id:'p',type:'paragraph',content:[{type:'text',text:'Seed',styles:{}}],children:[]}])});
 async function start() {
  server=http.createServer(async(req,res)=>{
   try {
    const url='http://localhost'+req.url;
    let response;
    if(req.method==='POST'){
     let body='';for await(const chunk of req)body+=chunk;
     commitBodies.push(body);
     if(delayNext){delayNext=false;await new Promise(resolve=>{held=resolve;});}
     response=await route.POST(new NextRequest(url,{method:'POST',headers:req.headers,body}));
     if(dropNext){dropNext=false;await new Promise(resolve=>{dropped={resolve,status:response.status};});res.destroy();return;}
    }else {
     user=db.prepare('SELECT * FROM users WHERE id=?').get(req.headers.cookie==='actor-b'?'actor-b':'actor');
     response=await authorize.GET(new NextRequest(url));
    }
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
   }catch(e){res.writeHead(500);res.end(String(e));}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const file=path.resolve('server/collab.cjs'),m=new Module(file);
  m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));
  m._compile(fs.readFileSync(file,'utf8').replace('const PERSIST_DEBOUNCE_MS = 2000;','const PERSIST_DEBOUNCE_MS = 80;'),file);
  m.exports.attachCollab(server,{port:server.address().port});
 }
 async function client(actor="actor"){
  const c={doc:new Y.Doc(),acks:[],synced:false,closed:false};
  c.ws=new WebSocket('ws://127.0.0.1:'+server.address().port+'/collab?page='+page.id+'&epoch=0',{headers:{cookie:actor}});
  const send=b=>{if(c.ws.readyState===WebSocket.OPEN)c.ws.send(b);};
  c.doc.on('update',(u,origin)=>{if(origin===c)return;const e=encoding.createEncoder();encoding.writeVarUint(e,0);sync.writeUpdate(e,u);send(encoding.toUint8Array(e));});
  c.ws.on('open',()=>{const e=encoding.createEncoder();encoding.writeVarUint(e,0);sync.writeSyncStep1(e,c.doc);send(encoding.toUint8Array(e));});
  c.ws.on('message',bytes=>{
   const d=decoding.createDecoder(new Uint8Array(bytes)),type=decoding.readVarUint(d);
   if(type===0){const e=encoding.createEncoder();encoding.writeVarUint(e,0);const subtype=sync.readSyncMessage(d,e,c.doc,c);if(encoding.length(e)>1)send(encoding.toUint8Array(e));if(subtype===sync.messageYjsSyncStep2)c.synced=true;}
   else if(type===2)c.acks.push(JSON.parse(decoding.readVarString(d)));
  });
  c.ws.on('error',e=>{c.error=e;});c.ws.on('close',()=>{c.closed=true;});
  c.barrier=id=>{const e=encoding.createEncoder();encoding.writeVarUint(e,2);encoding.writeVarUint(e,id);send(encoding.toUint8Array(e));};
  c.close=async()=>{c.ws.close();await until(()=>c.closed);c.doc.destroy();};
  clients.push(c);await until(()=>c.synced || c.error || c.closed);assert.ok(c.synced,'client connected and synchronized');return c;
 }
 function textNode(c){
  function walk(n){if(n instanceof Y.XmlText)return n;for(const child of n.toArray?.()??[]){const found=walk(child);if(found)return found;}}
  const n=walk(c.doc.getXmlFragment('blocknote'));assert.ok(n,'text node exists');return n;
 }
 const persisted=()=>projector.projectSharedState(db.prepare('SELECT state FROM collab_docs WHERE page_id=?').get(page.id).state);
 const body=()=>data.getPage(page.id).content;
 const hasAck=(c,id)=>c.acks.some(a=>a.requestId===id);
 await start();
 const a=await client(),b=await client("actor-b");
 textNode(a).insert(0,'A-');textNode(b).insert(0,'B-');
 a.barrier(1);b.barrier(1);
 await until(()=>hasAck(a,1)&&hasAck(b,1));
 await until(()=>textNode(a).toString()===textNode(b).toString());
 check('two real websocket clients converge and commit both edits',body().includes('A-')&&body().includes('B-')&&body()===persisted());
 await a.close();
 textNode(b).insert(textNode(b).length,'-after-A');b.barrier(2);await until(()=>hasAck(b,2));
 check('remaining editor saves after other client closes',body().includes('-after-A')&&body()===persisted());
 const vector=Buffer.from(Y.encodeStateVector(b.doc));textNode(b).delete(0,1);b.barrier(3);await until(()=>hasAck(b,3));
 check('deletion-only change is acknowledged after real projection commit',vector.equals(Buffer.from(Y.encodeStateVector(b.doc)))&&body()===persisted()&&body().includes(textNode(b).toString()));
 delayNext=true;textNode(b).insert(0,'old-snapshot-');b.barrier(4);await until(()=>held!==null);
 textNode(b).insert(0,'newer-edit-');b.barrier(5);
 check('delayed commit produces no premature acknowledgment',!hasAck(b,4)&&!hasAck(b,5));
 const release=held;held=null;release();await until(()=>hasAck(b,4));
 check('old snapshot acknowledgment does not acknowledge newer barrier',!hasAck(b,5));
 await until(()=>hasAck(b,5));
 check('newer snapshot gets its own durable acknowledgment',body().includes('newer-edit-')&&body()===persisted());
 delayNext=true;textNode(b).insert(0,'body-with-title-');b.barrier(6);await until(()=>held!==null);
 data.savePage(page.id,{title:'Independent title'});
 const releaseTitle=held;held=null;releaseTitle();await until(()=>hasAck(b,6));
 check('title edit during body projection remains independent',data.getPage(page.id).title==='Independent title'&&body().includes('body-with-title-'));
 dropNext=true;const dropIndex=commitBodies.length;
 textNode(b).insert(0,'committed-no-response-');b.barrier(7);
 await until(()=>dropped!==null);
 check('snapshot really commits before response is dropped',dropped.status===200&&body().includes('committed-no-response-')&&!hasAck(b,7));
 textNode(b).insert(0,'after-ambiguous-');b.barrier(8);
 dropped.resolve();dropped=null;
 await until(()=>hasAck(b,8));
 check('ambiguous outcome retries exact snapshot before newer edits',commitBodies[dropIndex]===commitBodies[dropIndex+1]&&hasAck(b,7)&&body().includes('after-ambiguous-')&&body()===persisted());
 const expected=body(),epoch=revisions.pageRevision(page.id).epoch;
 await b.close();await new Promise(r=>server.close(r));server=null;
 await start();let reloaded=await client();
 check('new server and client reload committed Yjs and page projection',body()===expected&&persisted()===expected&&projector.projectSharedState(Y.encodeStateAsUpdate(reloaded.doc))===expected&&epoch===0);
 const allowed=await client("actor-b");
 textNode(reloaded).insert(0,'durable-A-');reloaded.barrier(11);await until(()=>hasAck(reloaded,11));
 const beforeRevocation=body();
 db.prepare("UPDATE users SET role='member' WHERE id='actor'").run();
 db.prepare("DELETE FROM space_members WHERE user_id='actor'").run();
 const cleanBarrierIndex=commitBodies.length;
 allowed.barrier(12);await until(()=>hasAck(allowed,12)||allowed.closed);
 check('clean no-op barrier uses permitted requester after durable author revoked',hasAck(allowed,12)&&!allowed.closed&&body()===beforeRevocation);
 const cleanRequest=JSON.parse(commitBodies[cleanBarrierIndex]);
 check('clean barrier excludes already committed former contributor',cleanRequest.actorId==='actor-b'&&cleanRequest.actorIds.length===1&&cleanRequest.actorIds[0]==='actor-b');
 textNode(reloaded).insert(0,'unauthorized-frame-');reloaded.barrier(10);
 await until(()=>reloaded.closed);await wait(30);
 check('revoked socket update is rejected before merge or broadcast',!textNode(allowed).toString().includes('unauthorized-frame-')&&body()===beforeRevocation&&!hasAck(reloaded,10));
 db.prepare("UPDATE users SET role='admin' WHERE id='actor'").run();
 reloaded=await client();

 textNode(reloaded).insert(0,'revoked-A-');
 await until(()=>textNode(allowed).toString().includes('revoked-A-'));
 db.prepare("UPDATE users SET role='member' WHERE id='actor'").run();
 db.prepare("DELETE FROM space_members WHERE user_id='actor'").run();
 textNode(allowed).insert(0,'allowed-B-');allowed.barrier(9);
 await until(()=>allowed.closed&&reloaded.closed);
 check('allowed last actor cannot persist revoked contributor edits',body()===beforeRevocation&&!hasAck(allowed,9));
 await until(()=>Boolean(db.prepare('SELECT 1 FROM collab_recovery_updates WHERE page_id=?').get(page.id)));
 check('mixed revoked snapshot is retained for explicit recovery',Boolean(db.prepare('SELECT 1 FROM collab_recovery_updates WHERE page_id=?').get(page.id)));

 console.log(checks+' real two-client websocket integration checks passed');
} finally {
 held?.();dropped?.resolve();
 for(const c of clients){if(!c.closed){c.ws.terminate();await wait(10);}c.doc.destroy();}
 if(server)await new Promise(r=>server.close(r));
 db?.close();delete globalThis.__octavoDb;Module._load=originalLoad;Module._extensions['.ts']=originalTs;fs.rmSync(temp,{recursive:true,force:true});
}
