import "server-only";
import { createHash } from "node:crypto";
import { getDb } from "./db";
import { getPage, savePage } from "./data";
import { pageRevision } from "./page-revisions";
import { may } from "./roles";

export const collabHash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export class CollabCommitConflict extends Error {}
export type SharedCommit = {
  pageId:string; epoch:number; ownerId:string; actorId:string; actorIds:string[]; state:Uint8Array;
  expectedStateHash:string|null; expectedBodyHash:string; generation:number;
};
/** Projection happens before taking the SQLite lock; all base checks and writes
 * occur under one immediate transaction. No network or async work inside it. */
export async function commitSharedSnapshot(input: SharedCommit) {
  const { projectSharedState } = await import("./collab-projection");
  const content = projectSharedState(input.state);
  const stateHash = collabHash(input.state), bodyHash = collabHash(content);
  const db = getDb();
  return db.transaction(() => {
    const page = getPage(input.pageId);
    if (!page || pageRevision(page.id).epoch !== input.epoch)
      throw new CollabCommitConflict("Shared document epoch changed");
    const owner = db.prepare(`SELECT 1 FROM collab_room_leases WHERE page_id=? AND owner_id=? AND epoch=? AND expires_at>?`)
      .get(page.id,input.ownerId,input.epoch,Date.now());
    const competitor = db.prepare(`SELECT 1 FROM collab_room_leases WHERE page_id=? AND owner_id<>? AND expires_at>?`)
      .get(page.id,input.ownerId,Date.now());
    if (!owner || competitor) throw new CollabCommitConflict("Shared document ownership changed");
    if (!Array.isArray(input.actorIds) || !input.actorIds.length || !input.actorIds.includes(input.actorId))
      throw new CollabCommitConflict("Snapshot contributors are unavailable");
    for (const actorId of new Set(input.actorIds)) {
      const actor = db.prepare("SELECT * FROM users WHERE id=?").get(actorId) as Parameters<typeof may>[0] | undefined;
      if (!actor || !may(actor,page.space_id,"write")) throw new CollabCommitConflict("A contributor no longer has editing permission");
    }
    const previous = db.prepare("SELECT state FROM collab_docs WHERE page_id=?").get(page.id) as {state:Buffer}|undefined;
    const previousHash = previous ? collabHash(previous.state) : null;
    // Safe retry after commit-before-ack failure; not permission to overwrite a
    // different body that was changed out of band after the first commit.
    if (previousHash === stateHash && page.content === content)
      return {...pageRevision(page.id),stateHash,bodyHash,generation:input.generation};
    if (previousHash !== input.expectedStateHash || collabHash(page.content) !== input.expectedBodyHash)
      throw new CollabCommitConflict("Shared document or page body changed outside this coordinator");
    db.prepare(`INSERT INTO collab_docs(page_id,state,updated_at) VALUES(?,?,?)
      ON CONFLICT(page_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at`)
      .run(page.id,Buffer.from(input.state),Date.now());
    savePage(page.id,{content,by:input.actorId});
    return {...pageRevision(page.id),stateHash,bodyHash,generation:input.generation};
  }).immediate();
}
