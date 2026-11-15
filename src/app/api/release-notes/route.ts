import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { sameOrigin } from "@/lib/request-origin";
import { releaseState, acknowledgeRelease } from "@/lib/release-state";
import { VERSION } from "@/lib/version";
export const dynamic="force-dynamic";
const reply=(value:unknown,status=200)=>NextResponse.json(value,{status,headers:{"Cache-Control":"private, no-store"}});
export async function GET(){const user=await currentUser();if(!user)return reply({error:"Sign in required"},401);return reply(releaseState(user.id));}
export async function POST(req:NextRequest){if(!sameOrigin(req.headers))return reply({error:"Same-origin request required"},403);const user=await currentUser();if(!user)return reply({error:"Sign in required"},401);if(req.headers.get("x-octavo-version")!==VERSION||req.headers.get("x-octavo-user")!==user.id)return reply({error:"Account or version changed. Reload release notes."},409);acknowledgeRelease(user.id);return reply({ok:true});}
