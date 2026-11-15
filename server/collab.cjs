/**
 * The collaboration server: one Y.Doc per page, relayed over WebSocket.
 *
 * This runs outside the Next bundle. Next's own documentation is explicit
 * that Route Handlers cannot serve WebSockets — the connection closes when
 * the response is generated — so the socket has to be attached to the HTTP
 * listener itself. Doing that here rather than on a second port keeps the
 * one-container, one-port promise intact, which matters more for a
 * self-hosted tool than the tidiness of a separate service.
 *
 * Permission is NOT decided here. This process asks the app over localhost
 * and forwards the caller's cookies, so the capability matrix is consulted
 * in exactly one place and a copy of the rules cannot drift out of step.
 */

const { WebSocketServer } = require("ws");
const Y = require("yjs");
const syncProtocol = require("y-protocols/sync");
const awarenessProtocol = require("y-protocols/awareness");
const encoding = require("lib0/encoding");
const decoding = require("lib0/decoding");
const path = require("node:path");
const Database = require("better-sqlite3");
const { randomUUID, createHash } = require("node:crypto");

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_BARRIER = 2;
const projectionConfigs = new WeakMap();
const stateHash = bytes => createHash("sha256").update(bytes).digest("hex");

/** How long to wait for more edits before writing the document down. */
const PERSIST_DEBOUNCE_MS = 2000;
/** A room with nobody in it is dropped from memory after this. */
const EMPTY_ROOM_TTL_MS = 30_000;
const LEASE_RENEW_MS = 5000;
const LEASE_TTL_MS = 30_000;

const { collaborationEnabled } = require("./collab-config.cjs");

function openDb() {
  const dir = process.env.OCTAVO_DATA_DIR || path.join(process.cwd(), "data");
  const db = new Database(path.join(dir, "octavo.db"));
  db.pragma("journal_mode = WAL");
  return db;
}

/** page id -> room */
const rooms = new Map();
// Fenced dirty documents are not active rooms. Keep them until an additive
// recovery record has committed, including when SQLite is temporarily unavailable.
const quarantinedRooms = new Set();
const closingDbs = new Set();

function archiveQuarantined(room) {
  if (!quarantinedRooms.has(room)) return;
  room.recoveryTimer = null;
  try {
    // Disposal can be reached inside an outer transaction. Never destroy the
    // only copy after a nested savepoint that might subsequently roll back.
    if (room.db.inTransaction) throw new Error("waiting for outer transaction");
    const state = Buffer.from(Y.encodeStateAsUpdate(room.doc));
    room.db.transaction(() => {
      room.db.prepare(`INSERT INTO collab_recovery_updates(id,page_id,epoch,state,reason,created_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
        .run(room.recoveryId,room.pageId,room.epoch,state,room.recoveryReason,Date.now());
    }).immediate();
    quarantinedRooms.delete(room);
    room.dirty = false;
    room.doc.destroy();
    if (closingDbs.has(room.db) && ![...quarantinedRooms].some(r => r.db === room.db)) {
      closingDbs.delete(room.db);
      room.db.close();
    }
  } catch (err) {
    console.error("collab: recovery archival pending",room.pageId,err.message);
    // Intentionally referenced: graceful shutdown must not drop an unarchived
    // document. Forced process termination still needs a future durable ack protocol.
    room.recoveryTimer = setTimeout(() => archiveQuarantined(room), LEASE_RENEW_MS);
  }
}

function loadDoc(db, pageId) {
  const doc = new Y.Doc();
  const row = db
    .prepare("SELECT state FROM collab_docs WHERE page_id = ?")
    .get(pageId);
  if (row && row.state && row.state.length > 0) {
    try {
      Y.applyUpdate(doc, new Uint8Array(row.state));
    } catch (err) {
      // Do not replace unreadable persisted edits with an empty document.
      // Leave the original bytes untouched for recovery and reject admission.
      doc.destroy();
      throw new Error(`Invalid persisted collaboration state for ${pageId}: ${err.message}`);
    }
  }
  return doc;
}

/** Missing epoch metadata fails closed; application migration initializes all pages. */
function currentEpoch(db, pageId) {
  const row = db.prepare(`SELECT v.epoch FROM pages p
    JOIN page_edit_versions v ON v.page_id=p.id WHERE p.id=?`).get(pageId);
  return row && Number.isSafeInteger(row.epoch) && row.epoch >= 0 ? row.epoch : null;
}

function hasLease(db, room) {
  return Boolean(db.prepare(`SELECT 1 FROM collab_room_leases
    WHERE page_id=? AND owner_id=? AND epoch=? AND expires_at>?`)
    .get(room.pageId,room.ownerId,room.epoch,Date.now()));
}
function releaseLease(room) {
  if (room.leaseTimer) clearInterval(room.leaseTimer);
  room.leaseTimer = null;
  try { room.db.prepare("DELETE FROM collab_room_leases WHERE page_id=? AND owner_id=?").run(room.pageId,room.ownerId); }
  catch (err) { console.error("collab: lease release failed",room.pageId,err.message); }
}
function competingLease(db, room) {
  return Boolean(db.prepare(`SELECT 1 FROM collab_room_leases
    WHERE page_id=? AND owner_id<>? AND expires_at>? LIMIT 1`)
    .get(room.pageId,room.ownerId,Date.now()));
}
function acquireLease(db, room) {
  // All callers hold BEGIN IMMEDIATE: checking ownership and claiming cannot
  // race another SQLite connection. Never steal a still-live coordinator.
  if (!db.inTransaction) throw new Error("Lease admission requires a transaction");
  if (competingLease(db,room)) return false;
  db.prepare(`INSERT INTO collab_room_leases(page_id,owner_id,epoch,expires_at) VALUES(?,?,?,?)
    ON CONFLICT(page_id,owner_id) DO UPDATE SET epoch=excluded.epoch,expires_at=excluded.expires_at`)
    .run(room.pageId,room.ownerId,room.epoch,Date.now()+LEASE_TTL_MS);
  if (!room.leaseTimer) {
    room.leaseTimer = setInterval(() => renewLease(db,room),LEASE_RENEW_MS);
    room.leaseTimer.unref?.();
  }
  return true;
}
function renewLease(db, room) {
  if (room.disposed) return false;
  try {
    const renewed = db.transaction(() => {
      if (!requireCurrentEpoch(db,room)) return false;
      if (!acquireLease(db,room)) { disposeRoom(room); return false; }
      return true;
    }).immediate();
    if (!renewed) return false;
    if (room.conns.size === 0) {
      if (room.dirty) persist(db,room);
      if (room.disposed) return false;
      if (!room.dirty) releaseLease(room);
    }
    return true;
  } catch (err) {
    console.error("collab: lease renewal failed",room.pageId,err.message);
    // Continuing without a lease could admit an import over cached dirty edits.
    disposeRoom(room);
    return false;
  }
}

function disposeRoom(room, closeCode = 4409) {
  if (room.disposed) return;
  room.disposed = true;
  if (room.timer) clearTimeout(room.timer);
  if (room.reaper) clearTimeout(room.reaper);
  room.timer = room.reaper = null;
  releaseLease(room);
  // Never let a delayed close/reaper remove a newer room for this page.
  if (rooms.get(room.pageId) === room) rooms.delete(room.pageId);
  for (const [ws] of room.conns) {
    try { ws.close(closeCode, "Page changed; reload before reconnecting"); } catch { /* already closed */ }
  }
  room.conns.clear();
  room.awareness.destroy();
  if (room.dirty) {
    room.recoveryId = randomUUID();
    room.recoveryReason = closeCode === 1001 ? "shutdown-unpersisted" : "epoch-or-lease-fenced";
    quarantinedRooms.add(room);
    // Defer outside any caller transaction, even if it later rolls back.
    room.recoveryTimer = setTimeout(() => archiveQuarantined(room), 0);
  } else {
    room.doc.destroy();
  }
}

function requireCurrentEpoch(db, room) {
  if (room.disposed) return false;
  try {
    if (rooms.get(room.pageId) === room && currentEpoch(db, room.pageId) === room.epoch &&
        hasLease(db,room) && !competingLease(db,room)) return true;
  } catch (err) {
    console.error("collab: epoch check failed", room.pageId, err.message);
  }
  disposeRoom(room);
  return false;
}

function requestBarrier(db,room,ws,requestId) {
  if (!room.projection || !Number.isSafeInteger(requestId) || requestId < 0 ||
      !room.conns.has(ws) || !requireCurrentEpoch(db,room)) return;
  // At most one outstanding barrier per socket is needed. Replacing it with a
  // newer request cannot acknowledge earlier than that newer ordered frame.
  room.barriers.set(ws,requestId);
  room.dirty = true;
  void persistProjected(db,room);
}

async function persistProjected(db,room) {
  if (room.disposed) return false;
  if (room.projectionFlight) return room.projectionFlight;
  if (!room.dirty && !room.barriers.size) return true;
  const work = async () => {
    if (!requireCurrentEpoch(db,room)) return false;
    // A timeout may mean the server committed but the response was lost.
    // Retain the exact unresolved request until its idempotent outcome is known.
    if (!room.pendingProjection) {
      const generation=room.generation;
      const state=Buffer.from(Y.encodeStateAsUpdate(room.doc));
      // A clean no-op barrier belongs to its freshly authorized requester, not
      // the author of an already durable edit. Dirty contributors remain intact.
      const requester=[...room.barriers.keys()].reverse().find(ws=>room.actors.has(ws));
      const actorId=room.contributors.size===0 && requester ? room.actors.get(requester) : room.actorId;
      room.pendingProjection={
        generation,hash:stateHash(state),covered:new Map(room.barriers),
        body:JSON.stringify({pageId:room.pageId,epoch:room.epoch,ownerId:room.ownerId,
          state:state.toString("base64"),expectedStateHash:room.persistedStateHash,
          expectedBodyHash:room.persistedBodyHash,actorId,
          actorIds:[...new Set([...room.contributors.keys(),actorId].filter(Boolean))],generation}),
      };
    }
    const {generation,hash,covered,body}=room.pendingProjection;
    try {
      const response=await fetch(`http://127.0.0.1:${room.projection.port}/api/collab/commit`,{
        method:"POST",headers:{"content-type":"application/json","x-octavo-collab-secret":room.projection.secret},
        body,
        signal:AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        if ([400,401,403,404,409,410,422].includes(response.status)) disposeRoom(room);
        throw new Error(`projection commit HTTP ${response.status}`);
      }
      const result=await response.json();
      if (result.epoch!==room.epoch || result.generation!==generation || result.stateHash!==hash ||
          !Number.isSafeInteger(result.revision) || result.revision<0 || !/^[a-f0-9]{64}$/.test(result.bodyHash ?? ""))
        throw new Error("invalid projection acknowledgment");
      if (!requireCurrentEpoch(db,room)) return false;
      room.persistedStateHash=hash;
      room.persistedBodyHash=result.bodyHash;
      room.pendingProjection=null;
      for (const [actor,lastGeneration] of room.contributors) {
        if (lastGeneration<=generation) room.contributors.delete(actor);
      }
      for (const [ws,requestId] of covered) {
        if (room.barriers.get(ws)===requestId) room.barriers.delete(ws);
        if (!room.conns.has(ws) || ws.readyState!==ws.OPEN) continue;
        const enc=encoding.createEncoder();
        encoding.writeVarUint(enc,MESSAGE_BARRIER);
        encoding.writeVarString(enc,JSON.stringify({requestId,...result}));
        try { ws.send(encoding.toUint8Array(enc)); } catch { /* client resends after reconnect */ }
      }
      room.dirty=room.generation!==generation || room.barriers.size>0;
      return true;
    } catch(err) {
      console.error("collab: projection persistence failed",room.pageId,err.message);
      return false;
    }
  };
  room.projectionFlight=work();
  try { return await room.projectionFlight; }
  finally {
    room.projectionFlight=null;
    if (!room.disposed) {
      if (room.dirty) {
        if (room.timer) clearTimeout(room.timer);
        room.timer=setTimeout(()=>void persistProjected(db,room),PERSIST_DEBOUNCE_MS);
      } else if (!room.conns.size) releaseLease(room);
    }
  }
}

function persist(db, room) {
  if (room.projection) return persistProjected(db,room);
  if (room.disposed) return false;
  try {
    // An immediate transaction closes the check/write race with coordinated imports.
    const persisted = db.transaction(() => {
      if (!requireCurrentEpoch(db, room)) return false;
      if (!room.dirty) return true;
      const state = Buffer.from(Y.encodeStateAsUpdate(room.doc));
      db.prepare(
        `INSERT INTO collab_docs (page_id, state, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(page_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`
      ).run(room.pageId, state, Date.now());
      return true;
    }).immediate();
    if (persisted) room.dirty = false;
    return persisted;
  } catch (err) {
    // Keep dirty set on a transient storage failure so a later flush can retry.
    console.error("collab: failed to persist", room.pageId, err.message);
    return false;
  }
}

function getRoom(db, pageId, expectedEpoch) {
  return db.transaction(() => getRoomAtEpoch(db, pageId, expectedEpoch)).immediate();
}

function getRoomAtEpoch(db, pageId, expectedEpoch) {
  const epoch = currentEpoch(db, pageId);
  let room = rooms.get(pageId);
  if (room && (room.epoch !== epoch || room.disposed)) { disposeRoom(room); room = null; }
  if (epoch === null || expectedEpoch !== epoch) return null;
  // A clean idle cache without a live lease is not authoritative: another
  // coordinator may have committed a newer document at the SAME epoch.
  if (room && (!hasLease(db,room) || competingLease(db,room))) { disposeRoom(room); room = null; }
  if (competingLease(db,{pageId,ownerId:room?.ownerId ?? ""})) return null;
  if (room) {
    if (!acquireLease(db,room)) { disposeRoom(room); return null; }
    if (room.reaper) {
      clearTimeout(room.reaper);
      room.reaper = null;
    }
    return room;
  }

  const doc = loadDoc(db, pageId);
  room = {
    pageId,
    epoch,
    db,
    disposed: false,
    ownerId: randomUUID(),
    projection: projectionConfigs.get(db) ?? null,
    generation: 0,
    actorId: null,
    contributors: new Map(),
    pendingProjection: null,
    actors: new WeakMap(),
    persistedBodyHash: stateHash(db.prepare("SELECT content FROM pages WHERE id=?").get(pageId)?.content ?? ""),
    barriers: new Map(),
    projectionFlight: null,
    persistedStateHash: (() => {const row=db.prepare("SELECT state FROM collab_docs WHERE page_id=?").get(pageId);return row ? stateHash(row.state) : null;})(),
    leaseTimer: null,
    doc,
    conns: new Map(),
    awareness: new awarenessProtocol.Awareness(doc),
    dirty: false,
    timer: null,
    reaper: null,
  };
  room.awareness.setLocalState(null);

  doc.on("update", (update, origin) => {
    if (!requireCurrentEpoch(db, room)) return;
    room.dirty = true;
    room.generation++;
    if (origin && room.actors.has(origin)) {
      room.actorId=room.actors.get(origin);
      room.contributors.set(room.actorId,room.generation);
    }
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeUpdate(enc, update);
    broadcast(room, encoding.toUint8Array(enc), origin);

    if (room.timer) clearTimeout(room.timer);
    room.timer = setTimeout(() => persist(db, room), PERSIST_DEBOUNCE_MS);
  });

  room.awareness.on("update", ({ added, updated, removed }, origin) => {
    if (!requireCurrentEpoch(db, room)) return;
    const changed = added.concat(updated, removed);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(room.awareness, changed)
    );
    broadcast(room, encoding.toUint8Array(enc), origin);
  });

  rooms.set(pageId, room);
  if (!acquireLease(db,room)) { disposeRoom(room); return null; }
  return room;
}

function broadcast(room, payload, exclude) {
  if (room.disposed) return;
  for (const [ws] of room.conns) {
    if (ws === exclude) continue;
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(payload);
      } catch {
        /* the close handler will clean this up */
      }
    }
  }
}

function closeConn(db, room, ws) {
  if (!room.conns.has(ws)) return;
  if (!requireCurrentEpoch(db, room)) return;
  const ids = room.conns.get(ws);
  room.conns.delete(ws);
  room.barriers.delete(ws);
  if (ids) {
    awarenessProtocol.removeAwarenessStates(room.awareness, [...ids], null);
  }
  if (room.conns.size === 0) {
    // Write immediately rather than waiting out the debounce: the last
    // person leaving is exactly when losing the tail of an edit would hurt.
    if (room.timer) clearTimeout(room.timer);
    persist(db, room);
    if (room.disposed) return;
    if (!room.dirty) releaseLease(room);
    const reap = () => {
      if (!room.disposed && room.conns.size === 0) {
        persist(db, room);
        if (!room.dirty) disposeRoom(room);
        else room.reaper = setTimeout(reap, EMPTY_ROOM_TTL_MS);
      }
    };
    room.reaper = setTimeout(reap, EMPTY_ROOM_TTL_MS);
  }
}

/**
 * Ask the app whether this request may edit this page. The cookies come
 * straight off the upgrade request, so the answer is the same one the app
 * would give for an ordinary page load.
 */
async function authorize(port, pageId, cookie) {
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/collab/authorize?page=${encodeURIComponent(pageId)}`,
      { headers: cookie ? { cookie } : {} }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.ok ? data : null;
  } catch (err) {
    console.error("collab: authorization check failed", err.message);
    return null;
  }
}

/**
 * Attach the collaboration endpoint to an existing HTTP server.
 * Returns false if it could not be attached, so the caller can say so.
 */
function attachCollab(server, { port }) {
  if (!collaborationEnabled()) return false;
  if (!server || typeof server.on !== "function") return false;

  const secret=process.env.OCTAVO_COLLAB_INTERNAL_SECRET;
  if (!secret || secret.length<32) throw new Error("Missing internal collaboration persistence secret");
  const db = openDb();
  projectionConfigs.set(db,{port,secret});
  const wss = new WebSocketServer({ noServer: true });

  // Next installs its own upgrade listener that destroys the socket for any
  // path it does not recognise. Both listeners fire, and ours has to await an
  // authorization check first, so Next's tears the connection down before we
  // answer. Take ownership of the event and hand everything that is not ours
  // straight back to the listeners that were already there.
  const inherited = server.listeners("upgrade").slice();
  server.removeAllListeners("upgrade");

  server.on("upgrade", async (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/collab") {
      for (const listener of inherited) listener.call(server, req, socket, head);
      return;
    }

    // Nothing may be read off the socket while the permission check is in
    // flight, or the first frames arrive with no one listening for them.
    socket.pause();

    const pageId = url.searchParams.get("page") ?? "";
    if (!pageId) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const epochText = url.searchParams.get("epoch");
    const expectedEpoch = epochText !== null && /^(0|[1-9][0-9]*)$/.test(epochText) ? Number(epochText) : NaN;
    if (!Number.isSafeInteger(expectedEpoch)) {
      socket.write("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const who = await authorize(port, pageId, req.headers.cookie);
    if (!who) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    socket.resume();

    wss.handleUpgrade(req, socket, head, (ws) => {
      let room;
      try { room = getRoom(db, pageId, expectedEpoch); }
      catch (err) { console.error("collab: room epoch check failed", pageId, err.message); }
      if (!room) { ws.close(4409, "Page changed; reload before reconnecting"); return; }
      room.conns.set(ws, new Set());
      room.actors.set(ws,who.userId);
      room.actorId ??= who.userId;

      // Step 1 of the Yjs handshake: tell the newcomer what we have.
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(enc, room.doc);
      ws.send(encoding.toUint8Array(enc));

      // And who else is here.
      const states = room.awareness.getStates();
      if (states.size > 0) {
        const aenc = encoding.createEncoder();
        encoding.writeVarUint(aenc, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          aenc,
          awarenessProtocol.encodeAwarenessUpdate(room.awareness, [
            ...states.keys(),
          ])
        );
        ws.send(encoding.toUint8Array(aenc));
      }

      const processFrame = (data) => {
        try {
          // No old-generation sync or awareness message may touch a new epoch.
          db.transaction(() => {
          if (!requireCurrentEpoch(db, room)) return;
          const bytes = new Uint8Array(data);
          const dec = decoding.createDecoder(bytes);
          const type = decoding.readVarUint(dec);
          if (type === MESSAGE_SYNC) {
            const out = encoding.createEncoder();
            encoding.writeVarUint(out, MESSAGE_SYNC);
            syncProtocol.readSyncMessage(dec, out, room.doc, ws);
            if (encoding.length(out) > 1) ws.send(encoding.toUint8Array(out));
          } else if (type === MESSAGE_BARRIER) {
            const requestId=decoding.readVarUint(dec);
            requestBarrier(db,room,ws,requestId);
          } else if (type === MESSAGE_AWARENESS) {
            awarenessProtocol.applyAwarenessUpdate(
              room.awareness,
              decoding.readVarUint8Array(dec),
              ws
            );
            // Remember which client ids arrived on this socket so they can be
            // cleared when it closes; a cursor left behind by a closed tab is
            // a ghost in the margin.
            const ids = room.conns.get(ws);
            if (ids) {
              for (const id of room.awareness.getStates().keys()) ids.add(id);
            }
          }
          }).immediate();
        } catch (err) {
          console.error("collab: bad message", err.message);
        }
      };
      // Experimental persistence revalidates write access before touching the
      // shared Y.Doc. A serial bounded queue preserves update/barrier ordering.
      const frameQueue=[];
      let queuedBytes=0,draining=false;
      const drainFrames=async () => {
        if (draining) return;
        draining=true;
        try {
          while (frameQueue.length && !room.disposed && room.conns.has(ws) && ws.readyState===ws.OPEN) {
            const data=frameQueue.shift();
            try {
              if (room.projection) {
                const permission=await authorize(port,pageId,req.headers.cookie);
                if (!permission || permission.userId!==who.userId) {
                  ws.close(4409,"Editing permission changed");
                  closeConn(db,room,ws);
                  break;
                }
              }
              if (!room.disposed && room.conns.has(ws) && ws.readyState===ws.OPEN) processFrame(data);
            } finally { queuedBytes-=data.length; }
          }
        } finally {
          draining=false;
          if (room.disposed || !room.conns.has(ws) || ws.readyState!==ws.OPEN) {
            frameQueue.length=0;queuedBytes=0;
          }
        }
      };
      ws.on("message",data=>{
        if (queuedBytes+data.length>4*1024*1024 || frameQueue.length>=1024) {
          ws.close(1009,"Collaboration queue limit exceeded");
          closeConn(db,room,ws);
          return;
        }
        frameQueue.push(data);queuedBytes+=data.length;
        void drainFrames();
      });

      ws.on("close", () => closeConn(db, room, ws));
      ws.on("error", () => closeConn(db, room, ws));
    });
  });

  // Nothing in flight should be lost on shutdown.
  const flush = () => {
    for (const room of rooms.values()) persist(db, room);
  };
  process.on("SIGTERM", flush);
  process.on("SIGINT", flush);
  process.on("beforeExit", flush);
  server.once("close", () => {
    for (const room of [...rooms.values()]) if (room.db === db) { persist(db, room); disposeRoom(room, 1001); }
    process.off("SIGTERM", flush);
    process.off("SIGINT", flush);
    process.off("beforeExit", flush);
    wss.close();
    if ([...quarantinedRooms].some(room => room.db === db)) closingDbs.add(db);
    else db.close();
  });

  return true;
}

module.exports = { attachCollab, collaborationEnabled };
