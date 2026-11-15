import type {ExchangeAuthority} from "./site-exchange-authority";
import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {DATA_DIR} from './db';
import {StagingInbox} from './site-exchange-staging';
import {exchangeLineage,importExchange,previewExchangeForStaging,stagingExchangeEnabled} from './site-exchange-app';

function requireEnabled(){if(!stagingExchangeEnabled())throw new Error('Staging review is not enabled');}
function open(spaceId:string,authorize?:ExchangeAuthority){
 authorize?.();
 requireEnabled();const lineage=exchangeLineage(spaceId),dir=path.join(DATA_DIR,'exchange-staging');
 fs.mkdirSync(dir,{recursive:true,mode:0o700});const ds=fs.lstatSync(dir);
 if(!ds.isDirectory()||ds.isSymbolicLink()||(ds.mode&0o077)!==0)throw new Error('Staging requires a private directory');
 const file=path.join(dir,'inbox.db');
 try{fs.closeSync(fs.openSync(file,'wx',0o600));}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw new Error('Staging requires a private database file');
 const db=new Database(file,{fileMustExist:true});
 try{return {db,lineage,inbox:new StagingInbox(db,{enabled:true,authorize,maxItems:1000,maxBytes:256*1024*1024,maxBundleBytes:32*1024*1024,
  verifyBundle:(bytes,selected)=>{requireEnabled();if(selected!==lineage||exchangeLineage(spaceId)!==lineage)throw new Error('Staging lineage changed');previewExchangeForStaging(spaceId,bytes.toString('utf8'));}})};}catch(error){db.close();throw error;}
}
export async function stageExchangeBundle(spaceId:string,raw:string,authorize?:ExchangeAuthority){
 requireEnabled();if(typeof raw!=='string'||Buffer.byteLength(raw)>32*1024*1024)throw new Error('Bundle exceeds limit');
 const {db,lineage,inbox}=open(spaceId,authorize);try{const bytes=Buffer.from(raw),sha256=createHash('sha256').update(bytes).digest('hex');await inbox.stage({bytes,lineage,sha256});return {staged:true,sha256,applied:false};}finally{db.close();}
}
export function listStagedExchange(spaceId:string,after=''){
 const {db,lineage,inbox}=open(spaceId);try{return inbox.listPage(lineage,after);}finally{db.close();}
}
export async function reviewStagedExchange(spaceId:string,sha256:string,download=false,authorize?:ExchangeAuthority){
 const {db,lineage,inbox}=open(spaceId,authorize);try{const bytes=await inbox.readVerified(lineage,sha256);requireEnabled();return download?{sha256,bundle:bytes.toString('utf8')}:{sha256,...previewExchangeForStaging(spaceId,bytes.toString('utf8'))};}finally{db.close();}
}
export async function importStagedExchange(spaceId:string,sha256:string,actorId:string,authorize?:ExchangeAuthority){
 const {db,lineage,inbox}=open(spaceId,authorize);let bytes:Buffer;
 try{bytes=await inbox.readVerified(lineage,sha256);}finally{db.close();}
 requireEnabled();if(exchangeLineage(spaceId)!==lineage)throw new Error('Staging lineage changed');
 // Existing import revalidates within the application transaction and retains conflicts/deletion holds.
 // The immutable inbox record remains; its existence is NOT an application receipt.
 return {sha256,...await importExchange(spaceId,bytes.toString('utf8'),actorId,authorize)};
}
