import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { requireTarget } from './target.mjs';
const base = process.argv[2] || 'http://127.0.0.1:8612';
await requireTarget(base);
const db = new Database('data/octavo.db');
db.pragma('foreign_keys = ON');
const id = 'order-test-' + randomBytes(6).toString('hex');
const token = randomBytes(24).toString('hex');
const now = Date.now();
const headers = { cookie: `octavo_session=${token}`, origin: new URL(base).origin };
let space;
const order = (pageId, direction, h = headers) => fetch(base + '/api/pages/order', {
  method: 'POST', headers: { ...h, 'content-type': 'application/json' },
  body: JSON.stringify({ space: space.slug, pageId, direction }),
});
try {
  db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id,id+'@example.test','Ordering test','disabled','member',now);
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token,id,now+3600000);
  const form = new FormData(); form.set('file', new Blob(['# First\n\nSynthetic content']), 'first.md');
  const imported = await fetch(base+'/api/import', { method:'POST', headers, body:form, redirect:'manual' });
  assert.equal(imported.status,303);
  const location = imported.headers.get('location');
  assert.match(location,/^\/(?!\/)/); assert.ok(!location.includes('error='));
  assert.equal((await fetch(new URL(location,base),{headers})).status,200);
  space = db.prepare('SELECT * FROM spaces WHERE slug=?').get(location.slice(1));
  const first = db.prepare('SELECT id FROM pages WHERE space_id=?').get(space.id).id;
  const add = db.prepare('INSERT INTO pages(id,space_id,parent_id,slug,title,position,published,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)');
  add.run(id+'-b',space.id,null,'second','Second',0,1,now+1,now);
  add.run(id+'-c',space.id,first,'child-a','Child A',0,1,now+2,now);
  add.run(id+'-d',space.id,first,'child-b','Child B',0,0,now+3,now);
  const siblings = parent => db.prepare('SELECT id FROM pages WHERE space_id=? AND parent_id IS ? ORDER BY position,created_at').all(space.id,parent).map(p=>p.id);
  // Equal starting positions are normalized; child groups stay attached.
  assert.equal((await order(id+'-b','up')).status,200);
  assert.deepEqual(siblings(null),[id+'-b',first]);
  assert.equal((await order(id+'-d','up')).status,200);
  assert.deepEqual(siblings(first),[id+'-d',id+'-c']);
  assert.equal((await order(id+'-b','up')).status,200);
  assert.deepEqual(siblings(null),[id+'-b',first]);
  assert.equal((await order(id+'-b','down')).status,200);
  assert.deepEqual(siblings(null),[first,id+'-b']);
  const drop = (pageId, targetId, placement) => fetch(base + '/api/pages/order', {
    method:'POST', headers:{...headers,'content-type':'application/json'},
    body:JSON.stringify({space:space.slug,pageId,targetId,placement}),
  });
  assert.equal((await drop(first,id+'-b','after')).status,200);
  assert.deepEqual(siblings(null),[id+'-b',first]);
  assert.equal((await drop(first,id+'-b','before')).status,200);
  assert.deepEqual(siblings(null),[first,id+'-b']);
  assert.equal((await drop(id+'-c',id+'-d','before')).status,200);
  assert.deepEqual(siblings(first),[id+'-c',id+'-d']);
  assert.equal((await drop(first,id+'-c','before')).status,404);
  assert.equal((await drop(first,'missing','before')).status,404);
  assert.equal((await drop(first,id+'-b','invalid')).status,400);
  assert.deepEqual(siblings(null),[first,id+'-b']);
  assert.equal((await order('missing','up')).status,404);
  assert.equal((await order(first,'sideways')).status,400);
  assert.equal((await order(first,'up',{})).status,401);
  assert.equal((await order(first,'up',{...headers,origin:'https://foreign.example'})).status,403);
  const foreign = db.prepare('SELECT id FROM pages WHERE space_id != ? LIMIT 1').get(space.id);
  if (foreign) assert.equal((await order(foreign.id,'up')).status,404);
  const burst = await Promise.all(Array.from({length:40},(_,i)=>drop(first,id+'-b',i%2?'before':'after')));
  assert.ok(burst.every(r=>r.status===200));
  assert.deepEqual(new Set(siblings(null)),new Set([first,id+'-b']));
  assert.deepEqual(siblings(first),[id+'-c',id+'-d']);
  assert.equal(db.prepare('SELECT COUNT(DISTINCT position) AS n FROM pages WHERE space_id=? AND parent_id IS NULL').get(space.id).n,2);
  db.prepare("UPDATE space_members SET role='reader' WHERE space_id=? AND user_id=?").run(space.id,id);
  assert.equal((await order(first,'down')).status,403);
  assert.equal((await fetch(base+'/'+space.slug+'/organize',{headers})).status,404);
  const nofile = await fetch(base+'/api/import',{method:'POST',headers,body:new FormData(),redirect:'manual'});
  assert.equal(nofile.headers.get('location'),'/import?error=nofile');
  const unauth = await fetch(base+'/api/import',{method:'POST',redirect:'manual'});
  assert.equal(unauth.headers.get('location'),'/login');
  console.log('PASS persisted root/nested ordering, tied positions, boundaries, invalid IDs/direction, reader/anonymous/cross-origin denial, and relative upload redirects.');
} finally {
  if (space) {
    db.prepare('DELETE FROM pages_fts WHERE page_id IN (SELECT id FROM pages WHERE space_id=?)').run(space.id);
    db.prepare('DELETE FROM spaces WHERE id=?').run(space.id);
  }
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  db.close();
}
