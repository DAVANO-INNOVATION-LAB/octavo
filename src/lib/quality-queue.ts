import "server-only";
import type { User } from "./auth";
import { qualityPages, requireQualityUser } from "./quality";
import type { ReviewState } from "./document-review";

export const QUALITY_QUEUE_STATES: readonly ReviewState[] = ["unreviewed","stale","changed","overdue","verified"];
export const QUALITY_QUEUE_EXPORT_LIMIT = 5000;
export type QualityQueueFilters = { search: string; state: ReviewState | "all"; owner: "all" | "me" | "unassigned" };
export type QualityQueuePage = ReturnType<typeof qualityPages>[number];
export type QualityQueueRow = {
  pageId: string; title: string; href: string; spaceName: string; spaceSlug: string;
  published: boolean; reviewState: ReviewState; ownerId: string | null;
  dueAt: number | null; verifiedAt: number | null; revision: string;
};
export type QualityQueueReport = {
  schema: "octavo.quality-queue"; version: 1; generatedAt: string;
  filters: QualityQueueFilters;
  counts: { editable: number; matched: number; exported: number };
  limit: number; truncated: boolean; rows: QualityQueueRow[];
};

export function normalizeQualityQueueFilters(input: {search?:string;state?:string;owner?:string} = {}): QualityQueueFilters {
  const search=(input.search??"").trim(),state=input.state||"all",owner=input.owner||"all";
  if(search.length>200 || (state!=="all"&&!QUALITY_QUEUE_STATES.includes(state as ReviewState)) || !["all","me","unassigned"].includes(owner))throw new Error("Invalid queue filters");
  return {search,state:state as QualityQueueFilters["state"],owner:owner as QualityQueueFilters["owner"]};
}

/** The caller supplies the existing qualityPages result, not an unscoped query. */
export function filterQualityQueue(pages: readonly QualityQueuePage[], userId: string, filters: QualityQueueFilters): QualityQueuePage[] {
  const words=filters.search.toLowerCase().split(/\s+/).filter(Boolean);
  return pages.filter(page=>{
    if(filters.state!=="all"&&page.state!==filters.state)return false;
    if(filters.owner==="me"&&page.review?.ownerId!==userId)return false;
    if(filters.owner==="unassigned"&&page.review?.ownerId)return false;
    const text=`${page.title} ${page.space_name}`.toLowerCase();
    return words.every(word=>text.includes(word));
  }).sort((a,b)=>{
    const compare=(left:string,right:string)=>left<right?-1:left>right?1:0;
    return compare(a.space_name,b.space_name)||compare(a.title,b.title)||compare(a.id,b.id);
  });
}

export function createQualityQueueReport(user: User | null, input: {search?:string;state?:string;owner?:string} = {}): QualityQueueReport {
  requireQualityUser(user);
  const filters=normalizeQualityQueueFilters(input),pages=qualityPages(user),matched=filterQualityQueue(pages,user.id,filters);
  const rows=matched.slice(0,QUALITY_QUEUE_EXPORT_LIMIT).map(page=>({
    pageId:page.id,title:page.title,href:`/${encodeURIComponent(page.space_slug)}/${encodeURIComponent(page.slug)}/edit`,
    spaceName:page.space_name,spaceSlug:page.space_slug,published:page.published===1,reviewState:page.state,
    ownerId:page.review?.ownerId??null,dueAt:page.review?.dueAt??null,verifiedAt:page.review?.verifiedAt??null,revision:page.revision,
  }));
  return {schema:"octavo.quality-queue",version:1,generatedAt:new Date().toISOString(),filters,
    counts:{editable:pages.length,matched:matched.length,exported:rows.length},limit:QUALITY_QUEUE_EXPORT_LIMIT,truncated:matched.length>rows.length,rows};
}

/** Quote every cell; a leading apostrophe prevents spreadsheet formula parsing
 * even when a formula marker follows whitespace or control/format characters. */
export function qualityQueueCsv(report: QualityQueueReport): string {
  const columns: (keyof QualityQueueRow)[]=["pageId","title","href","spaceName","spaceSlug","published","reviewState","ownerId","dueAt","verifiedAt","revision"];
  const cell=(value:unknown)=>{
    let text=value===null||value===undefined?"":String(value);
    if(/^[\s\p{Cc}\p{Cf}]*[=+\-@]/u.test(text))text="'"+text;
    return '"'+text.replaceAll('"','""')+'"';
  };
  return [columns.map(cell).join(","),...report.rows.map(row=>columns.map(key=>cell(row[key])).join(","))].join("\r\n")+"\r\n";
}
