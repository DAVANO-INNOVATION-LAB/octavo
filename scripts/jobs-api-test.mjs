import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {requireTarget} from './target.mjs';
const base=process.argv[2]||'http://127.0.0.1:8611';await requireTarget(base);
const db=new Database('data/octavo.db'),id='jobtest-'+randomBytes(6).toString('hex'),now=Date.now(), sessions={};
try {
 db.prepare('INSERT INTO spaces(id,slug,name,visibility,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,id,'Job test','private',now,now);
 for(const [role,instance] of [['editor','member'],['reader','member'],['agent','agent']]){
  const uid=id+role,token=randomBytes(24).toString('hex');sessions[role]=token;
  db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(uid,uid+'@example.test',role,'disabled',instance,now);
  db.prepare('INSERT INTO space_members(space_id,user_id,role,added_at) VALUES(?,?,?,?)').run(id,uid,role,now);
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token,uid,now+3600000);
 }
 const blocks=[{id:'code',type:'codeBlock',props:{language:'json'},content:[{type:'text',text:JSON.stringify({entrypoint:"python3 -c 'print(42)'"}),styles:{}}],children:[]}];
 db.prepare('INSERT INTO pages(id,space_id,slug,title,content,published,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?)').run(id,id,'job','Job',JSON.stringify(blocks),now,now);
 db.prepare('INSERT INTO connectors(id,name,type,base_url,space_id,created_by,created_at) VALUES(?,?,?,?,?,?,?)').run(id,'Ray fixture','ray',process.env.OCTAVO_RAY_TEST_URL||'http://127.0.0.1:8266',id,id+'editor',now);
 const submit=(role,extra={})=>fetch(base+'/api/runs',{method:'POST',headers:{cookie:'octavo_session='+sessions[role],origin:base,'Content-Type':'application/json',...extra},body:JSON.stringify({pageId:id,blockId:'code',connectorId:id,code:'untrusted ignored'})});
 assert.equal((await submit('reader')).status,403);assert.equal((await submit('agent')).status,403);assert.equal((await submit('editor',{origin:'https://other.example'})).status,403);assert.equal((await submit('editor')).status,400);
 db.prepare('UPDATE pages SET published=1 WHERE id=?').run(id);
 const r=await submit('editor');assert.equal(r.status,200);const run=await r.json();assert.equal(run.status,'running');assert.ok(run.runId);
 const headers={cookie:'octavo_session='+sessions.editor};let result;
 for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,500));const rr=await fetch(base+'/api/runs/'+run.runId,{headers});assert.equal(rr.status,200);result=await rr.json();if(result.status!=='running')break;}
 assert.equal(result.status,'succeeded');assert.ok(result.output.includes('42'));
 assert.equal((await fetch(base+'/api/runs/'+run.runId,{headers:{cookie:'octavo_session='+sessions.reader}})).status,404);
 assert.equal((await fetch(base+'/api/runs/'+run.runId,{method:'POST',headers:{...headers,origin:'https://other.example'}})).status,403);
 const saved=db.prepare('SELECT * FROM runs WHERE id=?').get(run.runId);assert.equal(saved.status,'succeeded');assert.ok(saved.remote_id);assert.ok(saved.finished);
 console.log('PASS live job API: draft, reader, agent and cross-origin rejection; saved code execution; persisted remote ID, logs, completion; run access control.');
}finally{
 db.prepare('DELETE FROM runs WHERE page_id=?').run(id);db.prepare('DELETE FROM connectors WHERE id=?').run(id);db.prepare('DELETE FROM pages WHERE id=?').run(id);db.prepare('DELETE FROM space_members WHERE space_id=?').run(id);db.prepare('DELETE FROM spaces WHERE id=?').run(id);
 for(const role of Object.keys(sessions)){db.prepare('DELETE FROM sessions WHERE user_id=?').run(id+role);db.prepare('DELETE FROM users WHERE id=?').run(id+role);}db.close();
}
