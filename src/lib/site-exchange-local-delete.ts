import "server-only";
import { getDb } from './db';
import { pageRevision,type PageRevision } from './page-revisions';
import { getPage,getSpace } from './data';
import { canEditSpace } from './roles';
import type { User } from './auth';
import { captureExchange,exchangeEngine } from './site-exchange-app';
import { archivePage } from './site-exchange-archive';
import { canonical } from './site-exchange';
import { boundExchangeSpace,LocalExchangeDeletionHeld } from './site-exchange-delete-guard';

/** Ordinary bound-page deletion is a signed, recoverable operation, never a
 * direct cascade. User authority and current state are rechecked under lock. */
export async function deleteLocalExchangePage(pageId:string,user:User,expected:PageRevision & {spaceId:string;tenantId:string|null}) {
 const projector=await import('./collab-projection');
 const db=getDb();
 return db.transaction(()=>{
  const page=getPage(pageId);
  if(!page||!expected||page.space_id!==expected.spaceId||getSpace(page.space_id)?.tenant_id!==expected.tenantId||!boundExchangeSpace(page.space_id))throw new LocalExchangeDeletionHeld('scope');
  const account=db.prepare('SELECT role,active FROM users WHERE id=?').get(user.id) as {role:string;active:number}|undefined;
  if(!account||account.active!==1||!canEditSpace({...user,role:account.role},page.space_id))throw new LocalExchangeDeletionHeld('forbidden');
  const current=pageRevision(pageId);
  if(!expected||!Number.isSafeInteger(expected.revision)||expected.revision<0||!Number.isSafeInteger(expected.epoch)||expected.epoch<0||current.revision!==expected.revision||current.epoch!==expected.epoch)throw new LocalExchangeDeletionHeld('stale');
  if(db.prepare('SELECT 1 FROM pages WHERE parent_id=?').get(pageId))throw new LocalExchangeDeletionHeld('children');
  if(db.prepare('SELECT 1 FROM collab_room_leases WHERE page_id=? AND expires_at>?').get(pageId,Date.now()))throw new LocalExchangeDeletionHeld('editors');
  const shared=db.prepare('SELECT state FROM collab_docs WHERE page_id=?').get(pageId) as {state:Buffer}|undefined;
  try{if(shared&&(!shared.state.length||canonical(JSON.parse(projector.projectSharedState(shared.state)))!==canonical(JSON.parse(projector.projectSharedState(projector.seedSharedState(page.content))))))throw new Error('divergent');}catch{throw new LocalExchangeDeletionHeld('divergent');}
  try{captureExchange(page.space_id);}catch{throw new LocalExchangeDeletionHeld('archive');}
  const {engine}=exchangeEngine();
  const mapping=db.prepare('SELECT p.lineage,p.doc_id FROM site_exchange_pages p JOIN site_exchange_bindings b ON b.lineage=p.lineage WHERE p.page_id=? AND b.space_id=?').get(pageId,page.space_id) as {lineage:string;doc_id:string}|undefined;
  if(!mapping)throw new LocalExchangeDeletionHeld('scope');
  const heads=engine.heads(mapping.lineage,mapping.doc_id);
  if(heads.length!==1||heads[0].body.deleted||engine.applied(mapping.lineage,mapping.doc_id)!==heads[0].id)throw new LocalExchangeDeletionHeld('conflicts');
  // Archive verification, tombstone and full-object removal share one transaction.
  const revision=engine.capture(mapping.lineage,mapping.doc_id,{title:page.title,content:'[]',parentDocId:heads[0].body.parentDocId,deleted:true,attachments:[]});
  try{archivePage(pageId,page.space_id);}catch{throw new LocalExchangeDeletionHeld('archive');}
  db.prepare('DELETE FROM site_exchange_holds WHERE lineage=? AND doc_id=?').run(mapping.lineage,mapping.doc_id);
  db.prepare('UPDATE site_exchange_pages SET hold=NULL WHERE lineage=? AND doc_id=?').run(mapping.lineage,mapping.doc_id);
  // A local removal must not commit an intent that cannot leave this site.
  try{engine.exportBundle(mapping.lineage);}catch{throw new LocalExchangeDeletionHeld('archive');}
  return {archived:true,pageId,revision};
 }).immediate();
}
