/* eslint-disable @typescript-eslint/no-require-imports -- Exercises the CommonJS server entry point and module loader. */
// Actual Yjs/SQLite room lifecycle and websocket epoch fencing, isolated fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const http = require('node:http');
const { once } = require('node:events');
const Database = require('better-sqlite3');
const Y = require('yjs');
const { WebSocket } = require('ws');
const encoding = require('lib0/encoding');
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octavo-collab-epoch-'));
process.env.OCTAVO_DATA_DIR = dir;
// Model the standalone wrapper's process-local coordinator capability.
process.env.OCTAVO_COLLAB_INTERNAL_SECRET = require('node:crypto').randomBytes(32).toString('hex');
const file = path.join(dir, 'octavo.db');
const db = new Database(file);
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE pages(id TEXT PRIMARY KEY,content TEXT DEFAULT '[]');
CREATE TABLE page_edit_versions(page_id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0,epoch INTEGER NOT NULL DEFAULT 0);
CREATE TABLE collab_recovery_updates(id TEXT PRIMARY KEY,page_id TEXT,epoch INTEGER,state BLOB,reason TEXT,created_at INTEGER);
CREATE TABLE collab_docs(page_id TEXT PRIMARY KEY,state BLOB,updated_at INTEGER);
CREATE TABLE collab_room_leases(page_id TEXT,owner_id TEXT,epoch INTEGER,expires_at INTEGER,PRIMARY KEY(page_id,owner_id));
INSERT INTO pages(id) VALUES('p'); INSERT INTO page_edit_versions(page_id) VALUES('p');`);
const sourcePath = path.resolve('server/collab.cjs');
function loadServer() {
 const mod = new Module(sourcePath, module);
 mod.filename = sourcePath; mod.paths = Module._nodeModulePaths(path.dirname(sourcePath));
 mod._compile(fs.readFileSync(sourcePath,'utf8').replace('const PERSIST_DEBOUNCE_MS = 2000;', 'const PERSIST_DEBOUNCE_MS = 25;').replace('const EMPTY_ROOM_TTL_MS = 30_000;', 'const EMPTY_ROOM_TTL_MS = 40;').replace('const LEASE_RENEW_MS = 5000;', 'const LEASE_RENEW_MS = 25;').replace('const LEASE_TTL_MS = 30_000;', 'const LEASE_TTL_MS = 500;') + '\nmodule.exports._test={rooms,getRoom,persist,closeConn,disposeRoom,currentEpoch,renewLease,hasLease,quarantinedRooms,archiveQuarantined};',sourcePath);
 return mod.exports;
}
function snapshot(text) { const d = new Y.Doc(); d.getText('text').insert(0,text); const state=Buffer.from(Y.encodeStateAsUpdate(d)); d.destroy(); return state; }
function savedText() { const row=db.prepare('SELECT state FROM collab_docs WHERE page_id=?').get('p'); if(!row)return null; const d=new Y.Doc();Y.applyUpdate(d,new Uint8Array(row.state));const s=d.getText('text').toString();d.destroy();return s; }
function replaceEpoch(epoch,text) { db.transaction(()=>{db.prepare('UPDATE page_edit_versions SET epoch=? WHERE page_id=?').run(epoch,'p');db.prepare('INSERT INTO collab_docs VALUES(?,?,?) ON CONFLICT(page_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at').run('p',snapshot(text),Date.now());}).immediate(); }
let checks=0, server, authorizeRace=false;
function check(name,cond) { assert.ok(cond,name);console.log(`ok ${++checks}: ${name}`); }
const api=loadServer(), t=api._test;
(async()=>{
 try {
  check('missing page and metadata fail closed',t.getRoom(db,'absent',0)===null);
  db.prepare('INSERT INTO pages(id) VALUES(?)').run('unversioned');
  check('existing page without epoch row fails closed',t.getRoom(db,'unversioned',0)===null);
  const invalid=Buffer.from([255,255,255]);
  db.prepare('INSERT INTO collab_docs VALUES(?,?,?)').run('p',invalid,Date.now());
  assert.throws(()=>t.getRoom(db,'p',0),/Invalid persisted collaboration state/);
  check('corrupt persisted Yjs rejects room and lease admission',!t.rooms.has('p') && db.prepare('SELECT count(*) AS n FROM collab_room_leases').get().n===0);
  check('corrupt persisted bytes remain untouched for recovery',db.prepare('SELECT state FROM collab_docs WHERE page_id=?').get('p').state.equals(invalid));
  db.prepare('UPDATE collab_docs SET state=? WHERE page_id=?').run(Buffer.alloc(0),'p');
  const emptySeed=t.getRoom(db,'p',0);
  check('zero-byte seed marker admits an empty room',emptySeed.doc.getText('text').toString()==='');
  t.disposeRoom(emptySeed);
  const old=t.getRoom(db,'p',0);
  check('room admission acquires matching live lease',t.hasLease(db,old));
  old.doc.getText('text').insert(0,'dirty-old');
  const closes=[]; const fake={readyState:1,OPEN:1,send(){},close(code){closes.push(code);}};
  old.conns.set(fake,new Set());
  const beforeLease=db.prepare('SELECT expires_at FROM collab_room_leases WHERE owner_id=?').get(old.ownerId).expires_at;
  await wait(35);
  check('active room renews its lease',db.prepare('SELECT expires_at FROM collab_room_leases WHERE owner_id=?').get(old.ownerId).expires_at>beforeLease);
  old.doc.getText('text').insert(0,'unsaved-');
  replaceEpoch(1,'imported');
  check('dirty old room refuses persist after epoch bump',t.persist(db,old)===false && savedText()==='imported');
  check('stale room releases its lease',!db.prepare('SELECT 1 FROM collab_room_leases WHERE owner_id=?').get(old.ownerId));
  check('stale room closes clients and clears timers',closes[0]===4409 && old.disposed && old.timer===null && old.reaper===null && !t.rooms.has('p'));
  await wait(60);check('delayed dirty flush cannot resurrect old Ydoc',savedText()==='imported');
  const recovered=db.prepare('SELECT * FROM collab_recovery_updates WHERE page_id=? AND epoch=0').get('p');
  const recoveredDoc=new Y.Doc();Y.applyUpdate(recoveredDoc,new Uint8Array(recovered.state));
  check('fenced dirty state archived additively and recoverable',recoveredDoc.getText('text').toString()==='unsaved-dirty-old' && recovered.reason==='epoch-or-lease-fenced' && savedText()==='imported');
  recoveredDoc.destroy();
  check('stale epoch connection cannot acquire room' ,t.getRoom(db,'p',0)===null);
  const current=t.getRoom(db,'p',1);check('reconnect loads materialized current epoch',current.epoch===1 && current.doc.getText('text').toString()==='imported');
  t.closeConn(db,old,fake);check('late close from stale room cannot remove current room',t.rooms.get('p')===current);
  // A cached clean room must also be evicted, not only one with unsaved edits.
  replaceEpoch(2,'newer');const newer=t.getRoom(db,'p',2);
  check('clean cached room is invalidated on epoch change',current.disposed && newer!==current && newer.doc.getText('text').toString()==='newer');
  newer.doc.getText('text').insert(5,'-edit');t.persist(db,newer);
  check('current epoch can persist normal edits',savedText()==='newer-edit');
  const leaving={close(){},readyState:1,OPEN:1,send(){}};newer.conns.set(leaving,new Set());t.closeConn(db,newer,leaving);
  check('final disconnect flushes then releases lease',!db.prepare('SELECT 1 FROM collab_room_leases WHERE owner_id=?').get(newer.ownerId));
  replaceEpoch(3,'after-leave');const replacement=t.getRoom(db,'p',3);
  await wait(70);check('old reaper does not destroy replacement room or state',t.rooms.get('p')===replacement && savedText()==='after-leave');
  t.disposeRoom(replacement);
  const restarted=loadServer(), restartRoom=restarted._test.getRoom(db,'p',3);
  check('fresh server module loads current epoch state after restart',restartRoom.epoch===3 && restartRoom.doc.getText('text').toString()==='after-leave');
  restarted._test.disposeRoom(restartRoom);
  const expired=t.getRoom(db,'p',3); expired.conns.set(fake,new Set()); expired.doc.getText('text').insert(0,'lost-lease-edit');
  db.prepare('DELETE FROM collab_room_leases WHERE owner_id=?').run(expired.ownerId);
  check('lost lease fences active dirty room instead of reacquiring silently',t.renewLease(db,expired)===false && expired.disposed && savedText()==='after-leave');
  // Archival failures retain the dirty document, detached from live rooms.
  db.exec("CREATE TRIGGER reject_recovery BEFORE INSERT ON collab_recovery_updates BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END");
  await wait(10);
  check('failed archival retains quarantined dirty document',t.quarantinedRooms.has(expired) && expired.dirty && expired.doc.getText('text').toString().includes('lost-lease-edit'));
  check('quarantined room cannot persist into live document',t.persist(db,expired)===false && savedText()==='after-leave');
  db.exec('DROP TRIGGER reject_recovery');
  await wait(60);
  const recoveredLease=db.prepare('SELECT state FROM collab_recovery_updates WHERE id=?').get(expired.recoveryId);
  check('archival retry commits recovery before destroying dirty document',Boolean(recoveredLease) && !t.quarantinedRooms.has(expired) && !expired.dirty);
  const failedFlush=t.getRoom(db,'p',3);failedFlush.conns.set(fake,new Set());failedFlush.doc.getText('text').insert(0,'last-disconnect-');
  db.exec("CREATE TRIGGER reject_flush BEFORE INSERT ON collab_docs BEGIN SELECT RAISE(ABORT,'fixture flush failure'); END");
  t.closeConn(db,failedFlush,fake);
  check('failed final disconnect retains dirty room and exclusion lease',failedFlush.dirty && t.hasLease(db,failedFlush));
  db.exec('DROP TRIGGER reject_flush');
  // Even disposal inside a rolled-back outer transaction must archive later.
  assert.throws(()=>db.transaction(()=>{t.disposeRoom(failedFlush);throw new Error('rollback fixture');}).immediate(),/rollback fixture/);
  check('disposal in rolled-back transaction keeps dirty bytes quarantined',t.quarantinedRooms.has(failedFlush) && failedFlush.dirty);
  await wait(30);
  const disconnectedRecovery=db.prepare('SELECT state FROM collab_recovery_updates WHERE id=?').get(failedFlush.recoveryId);
  const disconnectedDoc=new Y.Doc();Y.applyUpdate(disconnectedDoc,new Uint8Array(disconnectedRecovery.state));
  check('failed disconnect tail survives rollback and recovery commit',disconnectedDoc.getText('text').toString()==='last-disconnect-after-leave' && savedText()==='after-leave');
  disconnectedDoc.destroy();
  // Lease deletion in the aborted fixture transaction rolled back too.
  db.prepare('DELETE FROM collab_room_leases WHERE owner_id=?').run(failedFlush.ownerId);
  const timed=t.getRoom(db,'p',3);timed.conns.set(fake,new Set());
  db.prepare('UPDATE collab_room_leases SET expires_at=0 WHERE owner_id=?').run(timed.ownerId);
  check('expired lease fences active room',t.renewLease(db,timed)===false && timed.disposed);


  // Independent module instances model separate coordinators, each with its own
  // SQLite connection and in-memory rooms, sharing only the WAL database.
  db.prepare('INSERT INTO pages(id) VALUES(?)').run('coordinator');
  db.prepare('INSERT INTO page_edit_versions(page_id) VALUES(?)').run('coordinator');
  const db2=new Database(file), other=loadServer()._test;
  try {
    const first=t.getRoom(db,'coordinator',0);first.conns.set(fake,new Set());
    first.doc.getText('text').insert(0,'first-dirty');
    check('second database coordinator cannot claim live owned page',other.getRoom(db2,'coordinator',0)===null && t.hasLease(db,first) && first.dirty && !first.disposed);
    db.prepare('UPDATE collab_room_leases SET expires_at=0 WHERE owner_id=?').run(first.ownerId);
    const takeover=other.getRoom(db2,'coordinator',0);takeover.conns.set(fake,new Set());
    check('expired lease permits new coordinator takeover',Boolean(takeover) && other.hasLease(db2,takeover));
    check('old dirty coordinator fenced without overwriting successor',t.persist(db,first)===false && first.disposed && other.hasLease(db2,takeover));
    await wait(10);
    const rescue=db.prepare('SELECT state FROM collab_recovery_updates WHERE id=?').get(first.recoveryId);
    const rescuedDoc=new Y.Doc();Y.applyUpdate(rescuedDoc,new Uint8Array(rescue.state));
    check('expired owner unsaved edits retained in recovery archive',rescuedDoc.getText('text').toString()==='first-dirty');rescuedDoc.destroy();
    takeover.doc.getText('text').insert(0,'successor');
    other.closeConn(db2,takeover,fake); // clean cached room with lease released
    const returned=t.getRoom(db,'coordinator',0);returned.conns.set(fake,new Set());
    check('clean idle old cache cannot steal successor live lease',other.getRoom(db2,'coordinator',0)===null && takeover.disposed && t.hasLease(db,returned));
    returned.doc.getText('text').insert(0,'new-');
    t.closeConn(db,returned,fake);
    const reloaded=other.getRoom(db2,'coordinator',0);
    check('handoff reloads latest persisted same-epoch state',reloaded.doc.getText('text').toString()==='new-successor');
    other.disposeRoom(reloaded);
    const latest=t.getRoom(db,'coordinator',0);
    check('idle cache is rebuilt even when epoch is unchanged',latest!==returned && returned.disposed && latest.doc.getText('text').toString()==='new-successor');
    t.disposeRoom(latest);
  } finally {
    for(const room of [...other.rooms.values()])other.disposeRoom(room);
    await wait(30);
    db2.close();
  }

  server=http.createServer((req,res)=>{const epoch=db.prepare('SELECT epoch FROM page_edit_versions WHERE page_id=?').get('p').epoch;if(authorizeRace){authorizeRace=false;replaceEpoch(epoch+1,'authorization-race');}res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,epoch}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;api.attachCollab(server,{port});
  const url=epoch=>`ws://127.0.0.1:${port}/collab?page=p${epoch===undefined?'':`&epoch=${epoch}`}`;
  const rejected=await new Promise(resolve=>{const ws=new WebSocket(url());ws.on('error',()=>{});ws.on('unexpected-response',(_,res)=>{resolve(res.statusCode);res.resume();ws.terminate();});});
  check('websocket without epoch rejected with HTTP conflict',rejected===409);
  const stale=new WebSocket(url(2));stale.on('error',()=>{});const [staleCode]=await once(stale,'close');
  check('websocket stale epoch rejected with reload close code',staleCode===4409);
  const ws=new WebSocket(url(3));const handshake=once(ws,'message');await once(ws,'open');await handshake;
  check('current websocket connects and gets initial handshake',ws.readyState===WebSocket.OPEN);
  check('connected websocket holds a live exclusion lease',db.prepare('SELECT count(*) AS n FROM collab_room_leases WHERE expires_at>?').get(Date.now()).n===1);
  const client=new Y.Doc();client.getText('text').insert(0,'old-websocket-edit');
  const enc=encoding.createEncoder();encoding.writeVarUint(enc,0);syncProtocol.writeUpdate(enc,Y.encodeStateAsUpdate(client));
  replaceEpoch(4,'coordinated');const closed=once(ws,'close');ws.send(encoding.toUint8Array(enc));const [code]=await closed;
  await wait(50);check('old websocket sync update is fenced before handling and persistence',code===4409 && savedText()==='coordinated');client.destroy();
  const awa=new WebSocket(url(4));const awaHandshake=once(awa,'message');await once(awa,'open');await awaHandshake;
  replaceEpoch(5,'newest');const awarenessDoc=new Y.Doc(),awareness=new awarenessProtocol.Awareness(awarenessDoc);awareness.setLocalState({user:'fixture'});
  const ae=encoding.createEncoder();encoding.writeVarUint(ae,1);encoding.writeVarUint8Array(ae,awarenessProtocol.encodeAwarenessUpdate(awareness,[awareness.clientID]));
  const awaClosed=once(awa,'close');awa.send(encoding.toUint8Array(ae));const [awaCode]=await awaClosed;
  check('old websocket awareness is fenced before handling',awaCode===4409 && savedText()==='newest');awareness.destroy();awarenessDoc.destroy();
  authorizeRace=true;
  const admissionRace=new WebSocket(url(5));admissionRace.on('error',()=>{});const [admissionCode]=await once(admissionRace,'close');
  check('epoch is rechecked after authorization before room admission',admissionCode===4409 && savedText()==='authorization-race');
  const fresh=new WebSocket(url(6));const freshHandshake=once(fresh,'message');await once(fresh,'open');await freshHandshake;
  check('new epoch websocket reconnect succeeds',fresh.readyState===WebSocket.OPEN);
  const freshClosed=once(fresh,'close');fresh.close();await freshClosed;await wait(10);
  check('websocket final disconnect releases exclusion lease',db.prepare('SELECT count(*) AS n FROM collab_room_leases').get().n===0);

 } finally {
  for(const room of [...t.rooms.values()])t.disposeRoom(room);
  await wait(60);
  if(server)await new Promise(resolve=>server.close(resolve));
  check('server shutdown releases owned leases',db.prepare('SELECT count(*) AS n FROM collab_room_leases').get().n===0);
  db.close();fs.rmSync(dir,{recursive:true,force:true});
  console.log(`${checks} epoch fencing checks passed`);
 }
})().catch(err=>{console.error(err);process.exitCode=1;});
