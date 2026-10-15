import { sameOrigin } from "@/lib/request-origin";
import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getPage } from "@/lib/data";
import { isAgent, may } from "@/lib/roles";
import { refreshRun } from "@/lib/connectors";
async function handle(req: NextRequest, context: {params:Promise<{id:string}>}, stop: boolean) {
  const user = await currentUser();
  if (!user) return NextResponse.json({error:"unauthorized"},{status:401});
  const {id} = await context.params;
  const run = getDb().prepare("SELECT page_id FROM runs WHERE id=?").get(id) as {page_id:string}|undefined;
  const page = run ? getPage(run.page_id) : null;
  if (!page || isAgent(user) || !may(user,page.space_id,"write")) return NextResponse.json({error:"not found"},{status:404});
  if(stop && !sameOrigin(req.headers)) return NextResponse.json({error:"origin mismatch"},{status:403});
  try { return NextResponse.json(await refreshRun(id,stop)); }
  catch { return NextResponse.json({error:"Unable to reach the job service. The job state is unchanged; check the target before resubmitting."},{status:502}); }
}
export const GET = (req:NextRequest,ctx:{params:Promise<{id:string}>}) => handle(req,ctx,false);
export const POST = (req:NextRequest,ctx:{params:Promise<{id:string}>}) => handle(req,ctx,true);
