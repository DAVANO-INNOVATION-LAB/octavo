import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { editablePage, checkDigest, type RunbookCheck } from "@/lib/quality";
import { qualityRevision } from "@/lib/quality-checks";
export async function GET(_req: Request, {params}: {params: Promise<{id:string}>}) {
  try {
    const {id}=await params;
    const check=getDb().prepare("SELECT * FROM runbook_checks WHERE id=?").get(id) as RunbookCheck|undefined;
    if(!check) return new Response("Not found",{status:404});
    const page=editablePage(await currentUser(),check.page_id);
    return Response.json({checkId:id,pageId:page.id,revision:qualityRevision(page),definition:checkDigest(check),command:check.command,expected:check.expected},
      {headers:{"Content-Disposition":'attachment; filename="runbook-plan.json"',"Cache-Control":"no-store"}});
  } catch { return new Response("Not found or unauthorized",{status:403}); }
}
