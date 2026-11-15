import "server-only";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYDoc, yDocToBlocks } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { getDb } from "./db";
import { pageRevision } from "./page-revisions";
import { repoSemantic } from "./repo-content";

/** Experimental, plain/default-schema documents only. This module never clears
 * active shared state; the epoch is advanced with the replacement so every old
 * socket and delayed persistence write must be fenced by the server. */
export function materializeRepoDocument(blocks: unknown[]): Uint8Array {
  const editor = BlockNoteEditor.create();
  const doc = blocksToYDoc(editor,blocks as never,"blocknote");
  try {
    // Parsing the new document now catches schema incompatibility before writes.
    yDocToBlocks(editor,doc,"blocknote");
    return Y.encodeStateAsUpdate(doc);
  } finally { doc.destroy(); }
}
export function replaceSharedDocument(pageId: string, state: Uint8Array): number {
  const db = getDb();
  // Caller holds the same transaction as page content and checkpoint writes.
  if (!db.inTransaction) throw new Error("Shared document replacement requires a transaction");
  const {epoch} = pageRevision(pageId);
  db.prepare("UPDATE page_edit_versions SET epoch=epoch+1 WHERE page_id=? AND epoch=?").run(pageId,epoch);
  db.prepare(`INSERT INTO collab_docs(page_id,state,updated_at) VALUES(?,?,?)
    ON CONFLICT(page_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at`).run(pageId,Buffer.from(state),Date.now());
  return epoch+1;
}

/** Called again while holding the write transaction. Active editing is a hold,
 * not an invitation to replace a live document. A stale/offline client later
 * reconnects with its old epoch and must recover its draft explicitly. */
export function sharedDocumentSafety(pageId: string, content: string): string | null {
  const db = getDb();
  if (db.prepare("SELECT 1 FROM collab_room_leases WHERE page_id=? AND expires_at>? LIMIT 1").get(pageId,Date.now()))
    return "Collaborative editor is active; remote replacement held until editors close and synchronize.";
  const row = db.prepare("SELECT state FROM collab_docs WHERE page_id=?").get(pageId) as {state:Buffer} | undefined;
  if (!row) return null;
  if (!row.state.length) return "Collaborative editor seed is pending; remote replacement held.";
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc,new Uint8Array(row.state));
    const editor = BlockNoteEditor.create();
    const stored = yDocToBlocks(editor,doc,"blocknote");
    if (repoSemantic(stored) !== repoSemantic(JSON.parse(content)))
      return "Shared document has edits not reflected in the page; remote replacement held.";
    return null;
  } catch { return "Shared document cannot be materialized safely; remote replacement held."; }
  finally { doc.destroy(); }
}
