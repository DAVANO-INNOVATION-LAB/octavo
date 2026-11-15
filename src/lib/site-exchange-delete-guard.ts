import "server-only";
import { getDb } from "./db";

/** No protocol tables are created while checking ordinary deletion paths. */
export function boundExchangeSpace(spaceId:string):boolean {
 const db=getDb();
 return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='site_exchange_bindings'").get() && !!db.prepare('SELECT 1 FROM site_exchange_bindings WHERE space_id=?').get(spaceId);
}
export function exchangeManagedPage(pageId:string,spaceId:string):boolean {
 if(boundExchangeSpace(spaceId))return true;
 const db=getDb();
 return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='site_exchange_pages'").get() && !!db.prepare('SELECT 1 FROM site_exchange_pages WHERE page_id=?').get(pageId);
}
export const localDeleteMessages={
 stale:'This page changed after deletion was confirmed. Review the current saved page before trying again.',
 editors:'A shared editor is still active. Close the other editor tabs, wait for saved changes to finish, then retry.',
 divergent:'Shared document state differs from the saved page. Recover and save those edits before deleting.',
 children:'This page has children. Archive child pages individually before deleting their parent.',
 conflicts:'This document has unresolved exchange revisions. Resolve them before deleting.',
 archive:'The complete local archive could not be verified. Nothing was deleted. Review attachment, repository mapping, schema, and recovery requirements.',
 scope:'The page moved or its exchange scope changed. Reload before requesting deletion.',
 forbidden:'You no longer have permission to delete this page.',
} as const;
export type LocalDeleteHold=keyof typeof localDeleteMessages;
export class LocalExchangeDeletionHeld extends Error {
 constructor(readonly reason:LocalDeleteHold){super(localDeleteMessages[reason]);this.name='LocalExchangeDeletionHeld';}
}
