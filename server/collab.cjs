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

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/** How long to wait for more edits before writing the document down. */
const PERSIST_DEBOUNCE_MS = 2000;
/** A room with nobody in it is dropped from memory after this. */
const EMPTY_ROOM_TTL_MS = 30_000;

function openDb() {
  const dir = process.env.OCTAVO_DATA_DIR || path.join(process.cwd(), "data");
  const db = new Database(path.join(dir, "octavo.db"));
  db.pragma("journal_mode = WAL");
  return db;
}

/** page id -> room */
const rooms = new Map();

function loadDoc(db, pageId) {
  const doc = new Y.Doc();
  const row = db
    .prepare("SELECT state FROM collab_docs WHERE page_id = ?")
    .get(pageId);
  if (row && row.state) {
    try {
      Y.applyUpdate(doc, new Uint8Array(row.state));
    } catch (err) {
      // A corrupt blob must not take the page offline: start clean and let
      // the first client seed the document from what the database still has.
      console.error("collab: could not load state for", pageId, err.message);
    }
  }
  return doc;
}

function persist(db, room) {
  if (!room.dirty) return;
  room.dirty = false;
  try {
    const state = Buffer.from(Y.encodeStateAsUpdate(room.doc));
    db.prepare(
      `INSERT INTO collab_docs (page_id, state, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(page_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`
    ).run(room.pageId, state, Date.now());
  } catch (err) {
    console.error("collab: failed to persist", room.pageId, err.message);
  }
}

function getRoom(db, pageId) {
  let room = rooms.get(pageId);
  if (room) {
    if (room.reaper) {
      clearTimeout(room.reaper);
      room.reaper = null;
    }
    return room;
  }

  const doc = loadDoc(db, pageId);
  room = {
    pageId,
    doc,
    conns: new Map(),
    awareness: new awarenessProtocol.Awareness(doc),
    dirty: false,
    timer: null,
    reaper: null,
  };
  room.awareness.setLocalState(null);

  doc.on("update", (update, origin) => {
    room.dirty = true;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeUpdate(enc, update);
    broadcast(room, encoding.toUint8Array(enc), origin);

    if (room.timer) clearTimeout(room.timer);
    room.timer = setTimeout(() => persist(db, room), PERSIST_DEBOUNCE_MS);
  });

  room.awareness.on("update", ({ added, updated, removed }, origin) => {
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
  return room;
}

function broadcast(room, payload, exclude) {
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
  const ids = room.conns.get(ws);
  room.conns.delete(ws);
  if (ids) {
    awarenessProtocol.removeAwarenessStates(room.awareness, [...ids], null);
  }
  if (room.conns.size === 0) {
    // Write immediately rather than waiting out the debounce: the last
    // person leaving is exactly when losing the tail of an edit would hurt.
    if (room.timer) clearTimeout(room.timer);
    persist(db, room);
    room.reaper = setTimeout(() => {
      if (room.conns.size === 0) {
        persist(db, room);
        room.doc.destroy();
        rooms.delete(room.pageId);
      }
    }, EMPTY_ROOM_TTL_MS);
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
  if (!server || typeof server.on !== "function") return false;

  const db = openDb();
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

    const who = await authorize(port, pageId, req.headers.cookie);
    if (!who) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    socket.resume();

    wss.handleUpgrade(req, socket, head, (ws) => {
      const room = getRoom(db, pageId);
      room.conns.set(ws, new Set());

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

      ws.on("message", (data) => {
        try {
          const bytes = new Uint8Array(data);
          const dec = decoding.createDecoder(bytes);
          const type = decoding.readVarUint(dec);
          if (type === MESSAGE_SYNC) {
            const out = encoding.createEncoder();
            encoding.writeVarUint(out, MESSAGE_SYNC);
            syncProtocol.readSyncMessage(dec, out, room.doc, ws);
            if (encoding.length(out) > 1) ws.send(encoding.toUint8Array(out));
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
        } catch (err) {
          console.error("collab: bad message", err.message);
        }
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

  return true;
}

module.exports = { attachCollab };
