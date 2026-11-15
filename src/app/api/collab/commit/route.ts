import { collaborationEnabled } from "@/lib/collab-config";
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { commitSharedSnapshot, CollabCommitConflict } from "@/lib/collab-commit";

export async function POST(req: NextRequest) {
  const secret = process.env.OCTAVO_COLLAB_INTERNAL_SECRET;
  const supplied = req.headers.get("x-octavo-collab-secret") ?? "";
  if (!collaborationEnabled() || !secret ||
      Buffer.byteLength(secret) !== Buffer.byteLength(supplied) ||
      !timingSafeEqual(Buffer.from(secret),Buffer.from(supplied)))
    return NextResponse.json({error:"forbidden"},{status:403});
  let body;
  try {
    // Shared state can be larger than JSON content; bound both encoded and raw
    // forms before decoding. This internal route is not a browser upload API.
    const text = await req.text();
    if (text.length > 24 * 1024 * 1024) return NextResponse.json({error:"too large"},{status:413});
    body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        ![body.pageId,body.ownerId,body.actorId].every(v=>typeof v === "string" && v.length > 0 && v.length < 256) ||
        !Array.isArray(body.actorIds) || !body.actorIds.length || body.actorIds.length > 10000 ||
        !body.actorIds.every((v:unknown)=>typeof v === "string" && v.length > 0 && v.length < 256) || !body.actorIds.includes(body.actorId) ||
        !Number.isSafeInteger(body.epoch) || body.epoch < 0 || !Number.isSafeInteger(body.generation) || body.generation < 0 ||
        !(body.expectedStateHash === null || /^[a-f0-9]{64}$/.test(body.expectedStateHash)) ||
        typeof body.expectedBodyHash !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedBodyHash) ||
        typeof body.state !== "string" || !body.state.length || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.state))
      return NextResponse.json({error:"invalid snapshot"},{status:400});
  } catch { return NextResponse.json({error:"invalid snapshot"},{status:400}); }
  const state = Buffer.from(body.state,"base64");
  if (state.toString("base64") !== body.state) return NextResponse.json({error:"invalid encoding"},{status:400});
  try { return NextResponse.json(await commitSharedSnapshot({...body,state})); }
  catch (error) {
    if (error instanceof CollabCommitConflict) return NextResponse.json({error:error.message},{status:409});
    // Projection/schema failures must not acknowledge or overwrite anything.
    console.error("collab: snapshot commit failed",error);
    return NextResponse.json({error:"snapshot could not be committed"},{status:503});
  }
}
