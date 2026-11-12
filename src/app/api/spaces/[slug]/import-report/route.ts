import { currentUser } from "@/lib/auth";
import { getSpaceBySlug } from "@/lib/data";
import { getImportReport } from "@/lib/import-reports";

export async function GET(_req: Request, {params}: {params: Promise<{slug:string}>}) {
  const {slug} = await params;
  const space = getSpaceBySlug(slug);
  const report = space ? getImportReport(await currentUser(),space.id) : null;
  const headers = {"Cache-Control":"private, no-store",Vary:"Cookie"};
  if (!report) return new Response("Not found",{status:404,headers});
  return Response.json(report,{headers:{...headers,"Content-Disposition":'attachment; filename="octavo-import-report.json"',"X-Content-Type-Options":"nosniff"}});
}
