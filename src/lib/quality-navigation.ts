import { normalizeQualityQueueFilters, type QualityQueueFilters, type QualityQueuePage } from "./quality-queue";

export type QualityNavigationContext = { filters: QualityQueueFilters; queue: number };
export function qualityNavigationContext(form: FormData): QualityNavigationContext {
  const read=(name:string)=>{const values=form.getAll(name);if(values.length>1||values.some(value=>typeof value!=="string"))throw new Error("Invalid queue context");return values.length?String(values[0]):undefined;};
  const filters=normalizeQualityQueueFilters({search:read("queueSearch"),state:read("queueState"),owner:read("queueOwner")});
  const raw=read("queuePage");
  if(raw!==undefined&&(!/^[1-9]\d*$/.test(raw)||!Number.isSafeInteger(Number(raw))))throw new Error("Invalid queue context");
  return {filters,queue:raw===undefined?1:Number(raw)};
}

export function qualityNavigationHref(context: QualityNavigationContext, status: {pageId?:string;error?:string;saved?:boolean;completed?:boolean;advanced?:boolean;reviewed?:boolean}): string {
  const params=new URLSearchParams({search:context.filters.search,state:context.filters.state,owner:context.filters.owner,queue:String(context.queue)});
  if(status.pageId)params.set("page",status.pageId);
  if(status.error)params.set("error",status.error);
  if(status.saved)params.set("saved","1");
  if(status.completed)params.set("completed","1");
  if(status.advanced)params.set("advanced","1");
  if(status.reviewed)params.set("reviewed","1");
  return `/quality?${params}`;
}

/** Follow the pre-action queue order, wrapping once; only retain documents
 * still matching current access/filters afterward. Newly matching items follow
 * the retained pre-action candidates. The processed document is never next. */
export function nextQualityDocument(before: readonly QualityQueuePage[], after: readonly QualityQueuePage[], currentId: string): {pageId:string;queue:number}|null {
  const index=before.findIndex(page=>page.id===currentId);
  if(index<0)return null;
  const eligible=new Map(after.map((page,index)=>({page,index})).filter(item=>item.page.id!==currentId).map(item=>[item.page.id,item]));
  const ordered=[...before.slice(index+1),...before.slice(0,index)];
  const next=ordered.map(page=>eligible.get(page.id)).find(Boolean)??eligible.values().next().value;
  return next?{pageId:next.page.id,queue:Math.floor(next.index/30)+1}:null;
}
