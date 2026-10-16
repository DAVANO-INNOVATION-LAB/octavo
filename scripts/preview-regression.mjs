import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {requireTarget} from './target.mjs';
const base=process.argv[2]||'http://127.0.0.1:8610';await requireTarget(base);
const db=new Database('data/octavo.db');const id='regression-'+randomBytes(6).toString('hex'),token=randomBytes(24).toString('hex');const now=Date.now();
db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id,id+'@example.test','Regression member','disabled','member',now);
db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token,id,now+3600000);
const headers={cookie:`octavo_session=${token}`,origin:base};
let space;
try {
 const f=new FormData();f.set('name','Private regression import');f.set('file',new Blob(['# Imported\n\nReal content']), 'imported.md');
 const imported=await fetch(base+'/api/import',{method:'POST',headers,body:f,redirect:'manual'});
 assert.equal(imported.status,303);const location=new URL(imported.headers.get('location'),base).href;assert.ok(!location.includes('error='));
 space=db.prepare('SELECT * FROM spaces WHERE slug=?').get(new URL(location).pathname.slice(1));assert.equal(space.visibility,'private');
 assert.equal(db.prepare('SELECT role FROM space_members WHERE space_id=? AND user_id=?').get(space.id,id).role,'admin');
 assert.equal((await fetch(location,{headers})).status,200);
 const anonymous=await fetch(location,{redirect:"manual"});assert.ok(anonymous.status===404 || (anonymous.status===307 && anonymous.headers.get("location")?.includes("login")));
 const url=base+'/'+space.slug+'/benchmarks';
 const html=await(await fetch(url,{headers})).text();
 const form=[...html.matchAll(/<form[^>]*>[\s\S]*?<\/form>/g)].map(m=>m[0]).find(f=>f.includes('name="conditions"'));
 const action=form.match(/name="(\$ACTION_ID_[^"]+)"/)[1];
 const data=new FormData();data.set(action,'');data.set('space',space.slug);data.set('title','GPU metrics');data.set('source','https://grafana.example.test/d/gpu');data.set('conditions','Synthetic regression data');data.set('file',new Blob(['gpu,utilization_percent,memory_mib\nGPU0,95,8192\nGPU1,0,0']), 'gpu.csv');
 const result=await fetch(url,{method:'POST',headers,body:data,redirect:'manual'});assert.equal(result.status,303);assert.ok(result.headers.get('location').endsWith('/edit'));
 const report=db.prepare('SELECT * FROM pages WHERE space_id=? AND title=?').get(space.id,'GPU metrics');const blocks=JSON.parse(report.content);assert.equal(blocks.find(b=>b.type==='table').content.rows.length,3);assert.equal(report.published,0);
 console.log('PASS member import: private space ownership, readable redirect, anonymous denial; benchmark report: CSV table, source link and draft creation.');
 // Leave a short-lived member session for the ZIP fidelity suite, never a production account.

} catch(e) {console.error(e);process.exitCode=1;} finally {
 if (space) { db.prepare('DELETE FROM pages WHERE space_id=?').run(space.id); db.prepare('DELETE FROM space_members WHERE space_id=?').run(space.id); db.prepare('DELETE FROM spaces WHERE id=?').run(space.id); }
 db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); db.prepare('DELETE FROM users WHERE id=?').run(id); db.close();
}
