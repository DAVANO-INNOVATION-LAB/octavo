import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { canReadSpace, canEditSpace } from "@/lib/roles";
import { getDb } from "@/lib/db";
import { getSpace } from "@/lib/data";
import { exchangeEngine } from "@/lib/site-exchange-app";
import { resolvePageLink, resolveSourcePageLink } from "@/lib/site-exchange-links";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"private, no-store","Vary":"Cookie"};
export async function GET(req:NextRequest){
 const user=await currentUser();
 const q=req.nextUrl.searchParams,spaceId=q.get('spaceId')??'',docId=q.get('docId')??'',tail=q.get('suffix')??'';
 const space=getSpace(spaceId);if(!space||!canReadSpace(user,space))return new NextResponse('not found',{status:user?404:401,headers});
 try{
  const db=getDb();
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='site_exchange_bindings'").get()||!db.prepare('SELECT 1 FROM site_exchange_bindings WHERE space_id=?').get(spaceId))return new NextResponse('not found',{status:404,headers});
  let targetDoc=docId;
  if(q.has('sourcePageId')){
   if(q.has('docId'))throw new Error('Ambiguous link context');
   const linked=resolveSourcePageLink(spaceId,q.get('sourcePageId')??'',q.get('path')??'');
   if(linked.source.published===0&&!canEditSpace(user,spaceId))return new NextResponse('not found',{status:404,headers});
   targetDoc=linked.docId;
  }
  const target=resolvePageLink(spaceId,targetDoc,tail,exchangeEngine().engine);
  // Match existing page-export access: private drafts are not exposed to readers.
  if(target.page.published===0&&!canEditSpace(user,spaceId))return new NextResponse('not found',{status:404,headers});
  return new NextResponse(null,{status:307,headers:{...headers,Location:target.location}});
 }catch{return new NextResponse('Document target unavailable or pending exchange review',{status:404,headers});}
}
