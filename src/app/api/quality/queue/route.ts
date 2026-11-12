import { currentUser } from "@/lib/auth";
import { requireQualityUser } from "@/lib/quality";
import { createQualityQueueReport, normalizeQualityQueueFilters, qualityQueueCsv } from "@/lib/quality-queue";

export async function GET(req: Request) {
  const headers: Record<string,string>={"Cache-Control":"private, no-store",Vary:"Cookie","X-Content-Type-Options":"nosniff"};
  const user=await currentUser();
  try{requireQualityUser(user);}catch{return new Response("Not found",{status:404,headers});}
  const params=new URL(req.url).searchParams,format=params.get("format")??"json";
  if(!["json","csv"].includes(format))return new Response("Invalid request",{status:400,headers});
  let filters;
  try{filters=normalizeQualityQueueFilters({search:params.get("search")??undefined,state:params.get("state")??undefined,owner:params.get("owner")??undefined});}
  catch{return new Response("Invalid request",{status:400,headers});}
  try{
    const report=createQualityQueueReport(user,filters);
    headers["Content-Disposition"]=`attachment; filename="octavo-quality-queue.${format}"`;
    headers["X-Octavo-Export-Truncated"]=String(report.truncated);
    headers["X-Octavo-Matched-Rows"]=String(report.counts.matched);
    headers["X-Octavo-Exported-Rows"]=String(report.counts.exported);
    if(format==="csv")return new Response(qualityQueueCsv(report),{headers:{...headers,"Content-Type":"text/csv; charset=utf-8"}});
    return Response.json(report,{headers});
  }catch{return new Response("Export unavailable",{status:500,headers});}
}
