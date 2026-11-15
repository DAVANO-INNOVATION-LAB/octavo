// Actual provider with deterministic sockets and real Yjs protocol frames.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module,{createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url),Y=require('yjs'),sync=require('y-protocols/sync'),enc=require('lib0/encoding'),dec=require('lib0/decoding');
const oldTs=Module._extensions['.ts'],oldWs=globalThis.WebSocket,oldWin=globalThis.window;
Module._extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const sockets=[];class Socket {static OPEN=1;readyState=0;sent=[];constructor(){sockets.push(this);}send(bytes){this.sent.push(bytes);}open(){this.readyState=1;this.onopen?.();}close(){this.readyState=3;this.onclose?.({code:1000});}receive(bytes){this.onmessage?.({data:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)});}}
globalThis.WebSocket=Socket;globalThis.window={location:{href:'http://test/'},addEventListener(){},removeEventListener(){},dispatchEvent(){}};
const {CollabProvider}=require(path.resolve('src/lib/collab-provider.ts'));
const frame=(write)=>{const e=enc.createEncoder();write(e);return enc.toUint8Array(e);};
const step2=doc=>frame(e=>{enc.writeVarUint(e,0);sync.writeSyncStep2(e,doc);});
const barriers=socket=>socket.sent.flatMap(bytes=>{const d=dec.createDecoder(bytes);return dec.readVarUint(d)===2?[dec.readVarUint(d)]:[];});
const ack=(socket,id,epoch=0)=>socket.receive(frame(e=>{enc.writeVarUint(e,2);enc.writeVarString(e,JSON.stringify({requestId:id,revision:1,epoch,generation:1,stateHash:'committed'}));}));
const tick=async()=>{for(let i=0;i<6;i++)await Promise.resolve();};
let checks=0;const providers=[];const check=async(name,fn)=>{await fn();console.log('ok',++checks,name);};
try{
 await check('two providers wait for commit acknowledgments, not handshake',async()=>{for(let i=0;i<2;i++){const p=new CollabProvider('ws://test/collab?page=p&epoch=0',new Y.Doc());providers.push(p);const socket=sockets.at(-1);socket.open();let done=false;const pending=p.persist().then(()=>done=true);await tick();assert.deepEqual(barriers(socket),[]);socket.receive(step2(new Y.Doc()));await tick();assert.equal(done,false);assert.equal(barriers(socket).length,1);ack(socket,999);await tick();assert.equal(done,false);ack(socket,barriers(socket)[0]);await pending;assert.equal(done,true);}});
 await check('deletion-only updates precede a barrier and remain unacknowledged',async()=>{const p=providers[0],s=sockets[0],t=p.doc.getText('text');t.insert(0,'x');const vector=Y.encodeStateVector(p.doc);t.delete(0,1);assert.deepEqual(Y.encodeStateVector(p.doc),vector);let done=false;const pending=p.persist().then(()=>done=true);await tick();assert.equal(done,false);const ids=barriers(s);assert.equal(ids.length,2);const types=s.sent.slice(-2).map(b=>dec.readVarUint(dec.createDecoder(b)));assert.deepEqual(types,[0,2]);ack(s,ids.at(-1));await pending;});
 await check('offline request resends only after reconnect sync and ignores old socket ack',async()=>{const p=providers[0],old=sockets[0];p.doc.getText('text').insert(0,'offline');let done=false;const pending=p.persist().then(()=>done=true);await tick();const id=barriers(old).at(-1);old.close();p.connect();const next=sockets.at(-1);next.open();await tick();assert.deepEqual(barriers(next),[]);ack(old,id);await tick();assert.equal(done,false);next.receive(step2(new Y.Doc()));await tick();assert.deepEqual(barriers(next),[id]);ack(next,id);await pending;});
 await check('coalesced barrier acknowledgment covers earlier ordered requests',async()=>{const p=providers[1],s=sockets[1];const first=p.persist(),second=p.persist();await tick();const ids=barriers(s);ack(s,ids.at(-1));const [a,b]=await Promise.all([first,second]);assert.ok(a.requestId<b.requestId);});
 await check('stale epoch closure rejects pending draft barriers',async()=>{const p=providers[1],s=sockets[1];const pending=p.persist();await tick();s.onclose({code:4409});await assert.rejects(pending,/preserve draft/);await assert.rejects(p.persist(),/closed/);});
 console.log(`${checks} provider barrier cases passed`);
}finally{for(const p of providers){p.destroy();p.doc.destroy();}Module._extensions['.ts']=oldTs;globalThis.WebSocket=oldWs;globalThis.window=oldWin;}
