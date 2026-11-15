import {exchangeSessionAuthority,ExchangeAuthorityError} from "@/lib/site-exchange-authority";
import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { MAX_EXCHANGE_RESOLUTION_HEADS } from "@/lib/site-exchange";
import { canAdminSpace } from "@/lib/roles";
import { sameOrigin } from "@/lib/request-origin";
import { acceptExchangeDeletion, applyExchange, bindExchange, exchangeStatus, readExchangeRevision, exportExchange, exportExchangeInventory, exportExchangeDelta, importExchange, resolveExchange, revokeExchange, trustExchange } from "@/lib/site-exchange-app";
import {stageExchangeBundle,listStagedExchange,reviewStagedExchange,importStagedExchange} from "@/lib/site-exchange-staging-app";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const reply=(value:unknown,status=200)=>NextResponse.json(value,{status,headers:{"Cache-Control":"no-store"}});
export async function GET(req:NextRequest) {
 const user=await currentUser();if(!user)return reply({error:"unauthorized"},401);if(user.role!=="admin")return reply({error:"forbidden"},403);
 const spaceId=req.nextUrl.searchParams.get("spaceId")||undefined;
 if(spaceId&&!canAdminSpace(user,spaceId))return reply({error:"forbidden"},403);
 try{
  const authorize=exchangeSessionAuthority(req.cookies.get("octavo_session")?.value,user.id,spaceId);authorize();
  const q=req.nextUrl.searchParams,docId=q.get("docId")||undefined,revision=q.get("revision");
  if(q.get("staging")){if(!spaceId)return reply({error:"Space required"},400);const digest=q.get("digest");return reply(digest?await reviewStagedExchange(spaceId,digest,q.get("download")==="1",authorize):listStagedExchange(spaceId,q.get("after")||""));}
  if(revision){if(!spaceId||!docId)return reply({error:"Space and document required"},400);return reply({revision:readExchangeRevision(spaceId,docId,revision)});}
  const number=(key:string)=>q.has(key)?Number(q.get(key)):undefined;
  const value=exchangeStatus(spaceId,{after:q.get("after")||undefined,limit:number("limit"),docId,historyAfter:q.get("historyAfter")||undefined,historyLimit:number("historyLimit")});
  return reply({...value,bindings:value.bindings.filter(b=>canAdminSpace(user,b.space_id))});
 }catch(error){return reply({error:error instanceof ExchangeAuthorityError?"forbidden":"Exchange status unavailable"},error instanceof ExchangeAuthorityError?403:400);}
}
async function boundedJson(req:NextRequest) {
 const reader=req.body?.getReader();if(!reader)throw new Error("Missing request body");const chunks:Uint8Array[]=[];let total=0;
 try{for(;;){const {value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>64*1024*1024+4096){await reader.cancel();throw new Error("Request exceeds limit");}chunks.push(value);}}finally{reader.releaseLock();}
 return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function POST(req:NextRequest) {
 const user=await currentUser();if(!user)return reply({error:"unauthorized"},401);if(user.role!=="admin")return reply({error:"forbidden"},403);
 // Cookie-authenticated configuration and data exchange require a same-origin browser request.
 if(!sameOrigin(req.headers))return reply({error:"same-origin request required"},403);
 if(!req.headers.get("content-type")?.startsWith("application/json"))return reply({error:"JSON required"},415);
 try {
  const body=await boundedJson(req);if(!body||typeof body!=="object"||Array.isArray(body)||typeof body.spaceId!=="string"||body.spaceId.length>128)throw new Error("Invalid request");
  const fresh=await currentUser();if(!fresh||fresh.id!==user.id)return reply({error:"unauthorized"},401);
  if(fresh.role!=="admin"||!canAdminSpace(fresh,body.spaceId))return reply({error:"forbidden"},403);
  const authorize=exchangeSessionAuthority(req.cookies.get("octavo_session")?.value,fresh.id,body.spaceId);authorize();
  let result:unknown;
  switch(body.action){
   case "bind":if(body.lineage!==undefined&&typeof body.lineage!=="string")throw new Error("Invalid lineage");result=bindExchange(body.spaceId,body.lineage);break;
   case "trust":if(typeof body.publicKey!=="string"||body.publicKey.length>2000)throw new Error("Invalid public key");result={siteId:trustExchange(body.spaceId,body.publicKey)};break;
   case "revoke":if(typeof body.peer!=="string"||!/^[a-f0-9]{64}$/.test(body.peer))throw new Error("Invalid peer");revokeExchange(body.spaceId,body.peer);result={ok:true};break;
   case "inventory":result={inventory:exportExchangeInventory(body.spaceId)};break;
   case "export-delta":if(typeof body.inventory!=="string")throw new Error("Signed receiver inventory required");result={bundle:exportExchangeDelta(body.spaceId,body.inventory)};break;
   case "export":result={bundle:exportExchange(body.spaceId)};break;
   case "stage":if(typeof body.bundle!=="string")throw new Error("Bundle required");result=await stageExchangeBundle(body.spaceId,body.bundle,authorize);break;
   case "stage-import":if(typeof body.digest!=="string"||body.confirmation!=="apply-nonconflicting")throw new Error("Explicit reviewed bundle confirmation required");result=await importStagedExchange(body.spaceId,body.digest,user.id,authorize);break;
   case "import":if(typeof body.bundle!=="string")throw new Error("Bundle required");result=await importExchange(body.spaceId,body.bundle,user.id,authorize);break;
   case "accept-deletion":if(typeof body.docId!=="string"||!Array.isArray(body.expectedHeads)||body.expectedHeads.length>100||!body.expectedHeads.every((x:unknown)=>typeof x==="string"))throw new Error("Invalid deletion acceptance");result=await acceptExchangeDeletion(body.spaceId,body.docId,body.expectedHeads,authorize);break;
   case "apply":result=await applyExchange(body.spaceId,user.id,authorize);break;
   case "resolve":if(typeof body.docId!=="string"||typeof body.selectedRevision!=="string"||!Array.isArray(body.expectedHeads)||body.expectedHeads.length>MAX_EXCHANGE_RESOLUTION_HEADS||!body.expectedHeads.every((x:unknown)=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x)))throw new Error("Invalid resolution");result=await resolveExchange(body.spaceId,body.docId,body.selectedRevision,body.expectedHeads,user.id,authorize);break;
   default:throw new Error("Unknown action");
  }
  return reply(result);
 }catch(error){if(error instanceof ExchangeAuthorityError)return reply({error:"forbidden"},403);const e=error as Error&{code?:string};return reply({error:e.code?"Local storage unavailable; no unsafe application performed":e.message||"Exchange failed"},409);}
}
