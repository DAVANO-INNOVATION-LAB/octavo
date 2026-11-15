import "server-only";
import { getDb } from "./db";
import { getPage, getPageBySlug, getSpace, getSpaceBySlug } from "./data";
import type { SiteExchange } from "./site-exchange";

const route="/api/site-exchange/link",base="https://octavo.invalid";
const failure=()=>new Error("Relative or local page links require an available same-space document mapping; exchange held");
function suffix(value:string){
 if(value.length>2048||/[\u0000-\u0020\u007f\\]/.test(value)||(value&&!/^[?#]/.test(value)))throw failure();
 const parsed=new URL('/'+value,base);if(parsed.pathname!=='/'||parsed.origin!==base||parsed.search+parsed.hash!==value)throw failure();return value;
}
function token(docId:string,tail:string){if(!docId||docId.length>128)throw failure();return `octavo-doc:${Buffer.from(docId).toString('base64url')}${suffix(tail)}`;}
function parseToken(value:string){const m=/^octavo-doc:([A-Za-z0-9_-]+)([?#].*)?$/.exec(value);if(!m)throw failure();const docId=Buffer.from(m[1],'base64url').toString('utf8');if(Buffer.from(docId).toString('base64url')!==m[1]||!docId||docId.length>128)throw failure();return {docId,tail:suffix(m[2]??'')};}
function transform(content:string,change:(value:string)=>string){
 const parsed=JSON.parse(content),pending:unknown[]=[parsed];
 while(pending.length){const v=pending.pop();if(Array.isArray(v)){pending.push(...v);continue;}if(!v||typeof v!=='object')continue;
  for(const [key,value] of Object.entries(v)){if((key==='href'||key==='url')&&typeof value==='string'&&value)(v as Record<string,unknown>)[key]=change(value);else if(value&&typeof value==='object')pending.push(value);}
 }
 return JSON.stringify(parsed);
}
function external(value:string){return /^(https?:\/\/|mailto:|tel:|#|octavo-asset:)/i.test(value);}
function localTarget(spaceId:string,lineage:string,docId:string){
 const mapping=getDb().prepare('SELECT page_id FROM site_exchange_pages WHERE lineage=? AND doc_id=?').get(lineage,docId) as {page_id:string}|undefined;
 const page=mapping?getPage(mapping.page_id):null;if(!page||page.space_id!==spaceId)throw failure();return page;
}
/** Only exact same-bound-space links become identities. External URLs are never fetched. */
export function portablePageLinks(content:string,pageId:string,lineage:string,engine:SiteExchange){
 const page=getPage(pageId),space=page?getSpace(page.space_id):null;if(!page||!space)throw failure();
 const source=getDb().prepare('SELECT doc_id FROM site_exchange_pages WHERE lineage=? AND page_id=?').get(lineage,pageId) as {doc_id:string}|undefined;if(!source)throw failure();
 const known=(docId:string)=>{const mapped=getDb().prepare('SELECT page_id FROM site_exchange_pages WHERE lineage=? AND doc_id=?').get(lineage,docId) as {page_id:string}|undefined;const target=mapped?getPage(mapped.page_id):null;if(target){if(target.space_id!==space.id)throw failure();return;}if(!engine.revisions(lineage,docId).length)throw failure();};
 return transform(content,value=>{
  if(external(value))return value;
  if(value.startsWith('octavo-doc:')){const p=parseToken(value);known(p.docId);return token(p.docId,p.tail);}
  if(/[\u0000-\u0020\u007f\\]/.test(value)||value.startsWith('//'))throw failure();
  let url:URL;try{url=new URL(value,`${base}/${encodeURIComponent(space.slug)}/${encodeURIComponent(page.slug)}`);}catch{throw failure();}
  if(url.origin!==base)throw failure();
  if(url.pathname===route){
   const keys=[...url.searchParams.keys()];if(keys.length!==3||new Set(keys).size!==3||keys.some(k=>!['spaceId','docId','suffix'].includes(k))||url.hash||url.searchParams.get('spaceId')!==space.id)throw failure();
   const docId=url.searchParams.get('docId')!;known(docId);return token(docId,url.searchParams.get('suffix')!);
  }
  let parts:string[];try{parts=url.pathname.split('/').slice(1).map(decodeURIComponent);}catch{throw failure();}
  if(parts.length!==2||parts.some(p=>/[\/\\\u0000-\u0020\u007f]/.test(p)))throw failure();
  const key=value.split(/[?#]/,1)[0],db=getDb(),alias=db.prepare('SELECT target_doc FROM site_exchange_link_aliases WHERE lineage=? AND source_doc=? AND path=?').get(lineage,source.doc_id,key) as {target_doc:string}|undefined;
  const namedSpace=getSpaceBySlug(parts[0]);
  // Never reinterpret an established path if its slug has been reused by another identity.
  if(namedSpace&&namedSpace.id!==space.id)throw failure();
  const target=namedSpace?.id===space.id?getPageBySlug(space.id,parts[1]):null;
  const mapping=target?db.prepare('SELECT doc_id FROM site_exchange_pages WHERE lineage=? AND page_id=?').get(lineage,target.id) as {doc_id:string}|undefined:undefined;
  if(alias){if(mapping&&mapping.doc_id!==alias.target_doc)throw new Error('Page-link path was reused by another document; explicit review required');known(alias.target_doc);return token(alias.target_doc,url.search+url.hash);}
  if(parts[0]!==space.slug||!mapping)throw failure();
  db.prepare('INSERT INTO site_exchange_link_aliases(lineage,source_doc,path,target_doc) VALUES(?,?,?,?)').run(lineage,source.doc_id,key,mapping.doc_id);
  return token(mapping.doc_id,url.search+url.hash);
 });
}
/** Stable local indirection permits forward/cyclic references without creating placeholder pages. */
export function localizePageLinks(content:string,spaceId:string,lineage:string,engine:SiteExchange){
 return transform(content,value=>{
  if(external(value))return value;
  const {docId,tail}=parseToken(value);
  if(!engine.revisions(lineage,docId).length)throw failure();
  return route+'?'+new URLSearchParams({spaceId,docId,suffix:tail}).toString();
 });
}
export function resolvePageLink(spaceId:string,docId:string,tail:string,engine:SiteExchange){
 suffix(tail);if(!spaceId||spaceId.length>128||!docId||docId.length>128)throw failure();
 const space=getSpace(spaceId),bound=getDb().prepare('SELECT lineage FROM site_exchange_bindings WHERE space_id=?').get(spaceId) as {lineage:string}|undefined;
 if(!space||!bound)throw failure();const heads=engine.heads(bound.lineage,docId);
 if(heads.length!==1||heads[0].body.deleted||engine.applied(bound.lineage,docId)!==heads[0].id)throw failure();
 const page=localTarget(spaceId,bound.lineage,docId);
 if([space.slug,page.slug].some(s=>!s||s==='.'||s==='..'||/[\/\\\u0000-\u0020\u007f]/.test(s)))throw failure();
 return {space,page,location:`/${encodeURIComponent(space.slug)}/${encodeURIComponent(page.slug)}${tail}`};
}

function sourceAliases(pageId:string){
 const db=getDb();
 for(const name of ['site_exchange_bindings','site_exchange_pages','site_exchange_link_aliases'])if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))return null;
 const page=getPage(pageId),space=page?getSpace(page.space_id):null;if(!page||!space)return null;
 const row=db.prepare('SELECT b.lineage,p.doc_id FROM site_exchange_bindings b JOIN site_exchange_pages p ON p.lineage=b.lineage WHERE b.space_id=? AND p.page_id=?').get(space.id,page.id) as {lineage:string;doc_id:string}|undefined;
 return row?{page,space,...row}:null;
}
/** Reader-only projection. Never persists content, changes aliases, or touches live Yjs buffers. */
export function readerPageLinks(content:string,pageId:string){
 const source=sourceAliases(pageId);if(!source)return content;
 const rows=getDb().prepare('SELECT path FROM site_exchange_link_aliases WHERE lineage=? AND source_doc=?').all(source.lineage,source.doc_id) as {path:string}[];
 const paths=new Set(rows.map(r=>r.path));if(!paths.size)return content;
 try{return transform(content,value=>{
  if(external(value)||value.startsWith('octavo-doc:'))return value;
  const path=value.split(/[?#]/,1)[0];if(!paths.has(path))return value;
  // Preserve even malformed suffixes for the resolver to reject, not fall back to a stale literal path.
  const tail=value.slice(path.length);
  return route+'?'+new URLSearchParams({spaceId:source.space.id,sourcePageId:pageId,path,suffix:tail}).toString();
 });}catch{return content;}
}
/** Revalidate the original source/path at click time: never guess after slug reuse. */
export function resolveSourcePageLink(spaceId:string,pageId:string,path:string){
 const source=sourceAliases(pageId);if(!source||source.space.id!==spaceId||!path||path.length>2048||/[?#\u0000-\u0020\u007f\\]/.test(path)||path.startsWith('//'))throw failure();
 const alias=getDb().prepare('SELECT target_doc FROM site_exchange_link_aliases WHERE lineage=? AND source_doc=? AND path=?').get(source.lineage,source.doc_id,path) as {target_doc:string}|undefined;if(!alias)throw failure();
 const url=new URL(path,`${base}/${encodeURIComponent(source.space.slug)}/${encodeURIComponent(source.page.slug)}`);
 if(url.origin!==base)throw failure();const parts=url.pathname.split('/').slice(1).map(decodeURIComponent);
 if(parts.length!==2||parts.some(p=>/[\/\\\u0000-\u0020\u007f]/.test(p)))throw failure();
 const named=getSpaceBySlug(parts[0]);if(named&&named.id!==spaceId)throw failure();
 const current=named?getPageBySlug(spaceId,parts[1]):null;
 if(current){const mapped=getDb().prepare('SELECT doc_id FROM site_exchange_pages WHERE lineage=? AND page_id=?').get(source.lineage,current.id) as {doc_id:string}|undefined;if(mapped?.doc_id!==alias.target_doc)throw failure();}
 return {source:source.page,docId:alias.target_doc};
}
