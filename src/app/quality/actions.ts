"use server";
import { currentUser } from "@/lib/auth";
import { qualityPages, requireQualityUser, updateQuality } from "@/lib/quality";
import { filterQualityQueue } from "@/lib/quality-queue";
import { nextQualityDocument, qualityNavigationContext, qualityNavigationHref, type QualityNavigationContext } from "@/lib/quality-navigation";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function qualityAction(form:FormData) {
  const id=String(form.get("pageId")??"");
  let context:QualityNavigationContext={filters:{search:"",state:"all",owner:"all"},queue:1};
  let destination="",error="",committed=false;
  const verifying=form.get("operation")==="verify";
  try {
    context=qualityNavigationContext(form);
    const user=await currentUser();
    const advanceValue=form.get("advance"),advance=advanceValue==="1";
    if((advanceValue!==null&&!advance)||form.getAll("advance").length>1||(advance&&form.get("operation")!=="verify"))throw new Error("Invalid review continuation");
    if(advance&&["queueSearch","queueState","queueOwner","queuePage"].some(key=>!form.has(key)))throw new Error("Queue context is required to continue reviewing");
    requireQualityUser(user);
    const before=advance?filterQualityQueue(qualityPages(user),user.id,context.filters):[];
    if(advance&&!before.some(page=>page.id===id))throw new Error("Selected document no longer matches this queue");
    updateQuality(user,form);
    committed=true;
    if(advance){
      const after=filterQualityQueue(qualityPages(user),user.id,context.filters);
      const next=nextQualityDocument(before,after,id);
      destination=qualityNavigationHref(next?{...context,queue:next.queue}:context,{pageId:next?.pageId??id,saved:true,completed:!next,advanced:!!next,reviewed:true});
    } else destination=qualityNavigationHref(context,{pageId:id,saved:true,reviewed:verifying});
  } catch(e) {
    error=committed?"Changes saved, but the next document could not be loaded. Refresh the queue.":e instanceof Error?e.message:"Unable to save";
    destination=qualityNavigationHref(context,{pageId:id,error,saved:committed,reviewed:committed&&verifying});
  }
  try {revalidatePath("/quality");} catch {
    destination=qualityNavigationHref(context,{pageId:id,error:committed?"Changes saved. Refresh the queue to see the latest state.":error||"Unable to refresh the queue",saved:committed,reviewed:committed&&verifying});
  }
  redirect(destination);
}
