"use client";

import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

/**
 * A Yjs provider over our own WebSocket endpoint.
 *
 * y-websocket would do this, but it carries optional dependencies for a
 * bundled server we do not use — one of them a LevelDB binding that puts a
 * native build in the image, and an old copy of `ws` beside the current one.
 * The protocol is two message types; carrying a native build to avoid writing
 * them is a bad trade.
 */

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

export type ConnectionState = "connecting" | "connected" | "offline";

export class CollabProvider {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  private ws: WebSocket | null = null;
  private url: string;
  private closed = false;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(s: ConnectionState) => void>();
  private state: ConnectionState = "connecting";
  /** True once the server has answered our first sync step. */
  synced = false;
  private syncedListeners = new Set<() => void>();

  constructor(url: string, doc: Y.Doc) {
    this.url = url;
    this.doc = doc;
    this.awareness = new awarenessProtocol.Awareness(doc);

    this.doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);
    // A tab that closes without cleanup leaves a cursor behind; say goodbye.
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", this.disconnectAwareness);
    }
    this.connect();
  }

  onStatus(fn: (s: ConnectionState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  onSynced(fn: () => void): () => void {
    if (this.synced) fn();
    else this.syncedListeners.add(fn);
    return () => this.syncedListeners.delete(fn);
  }

  private setState(s: ConnectionState) {
    if (this.state === s) return;
    this.state = s;
    for (const fn of this.listeners) fn(s);
  }

  private send(bytes: Uint8Array) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(bytes);
    }
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    // Updates that arrived from the socket must not be echoed back to it.
    if (origin === this) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeUpdate(enc, update);
    this.send(encoding.toUint8Array(enc));
  };

  private onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ) => {
    if (origin === this) return;
    const changed = added.concat(updated, removed);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)
    );
    this.send(encoding.toUint8Array(enc));
  };

  private disconnectAwareness = () => {
    awarenessProtocol.removeAwarenessStates(
      this.awareness,
      [this.doc.clientID],
      "unload"
    );
  };

  private connect() {
    if (this.closed) return;
    this.setState(this.retry === 0 ? "connecting" : "offline");

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.setState("connected");
      // Ask what the server has.
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(enc, this.doc);
      this.send(encoding.toUint8Array(enc));
      // And announce ourselves.
      const local = this.awareness.getLocalState();
      if (local) {
        const aenc = encoding.createEncoder();
        encoding.writeVarUint(aenc, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          aenc,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
            this.doc.clientID,
          ])
        );
        this.send(encoding.toUint8Array(aenc));
      }
    };

    ws.onmessage = (event) => {
      try {
        const bytes = new Uint8Array(event.data as ArrayBuffer);
        const dec = decoding.createDecoder(bytes);
        const type = decoding.readVarUint(dec);
        if (type === MESSAGE_SYNC) {
          const out = encoding.createEncoder();
          encoding.writeVarUint(out, MESSAGE_SYNC);
          const messageType = syncProtocol.readSyncMessage(
            dec,
            out,
            this.doc,
            this
          );
          if (encoding.length(out) > 1) this.send(encoding.toUint8Array(out));
          // A sync-step-2 or update means the server has told us everything
          // it has; only then is it safe to decide the document is empty.
          if (
            !this.synced &&
            (messageType === syncProtocol.messageYjsSyncStep2 ||
              messageType === syncProtocol.messageYjsUpdate)
          ) {
            this.synced = true;
            for (const fn of this.syncedListeners) fn();
            this.syncedListeners.clear();
          }
        } else if (type === MESSAGE_AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(
            this.awareness,
            decoding.readVarUint8Array(dec),
            this
          );
        }
      } catch {
        /* a malformed frame is not worth tearing the session down for */
      }
    };

    ws.onclose = () => {
      this.ws = null;
      // Remote cursors belong to a connection that no longer exists.
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        [...this.awareness.getStates().keys()].filter(
          (id) => id !== this.doc.clientID
        ),
        this
      );
      this.setState("offline");
      this.scheduleReconnect();
    };

    ws.onerror = () => ws.close();
  }

  private scheduleReconnect() {
    if (this.closed) return;
    // Back off, but never so far that a brief outage feels like a dead page.
    const delay = Math.min(1000 * 2 ** this.retry, 15000);
    this.retry++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  destroy() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.disconnectAwareness();
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    if (typeof window !== "undefined") {
      window.removeEventListener("beforeunload", this.disconnectAwareness);
    }
    this.awareness.destroy();
    this.ws?.close();
    this.ws = null;
  }
}

/** A stable, legible colour per person, so a cursor is recognisable. */
export function colorFor(id: string): string {
  const palette = [
    "#c0392b", "#2980b9", "#27ae60", "#8e44ad",
    "#d35400", "#16a085", "#2c3e50", "#b7950b",
  ];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}
