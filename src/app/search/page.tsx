import { now } from "@/lib/util";
import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { scopeFor } from "@/lib/roles";
import { searchPages } from "@/lib/data";
import { SiteHeader } from "@/components/SiteHeader";
export const dynamic="force-dynamic";
export const metadata={title:"Search"};
export default async function SearchPage({searchParams}:{searchParams:Promise<{q?:string;space?:string;kind?:string;owner?:string;days?:string;page?:string}>}) {
  const q=await searchParams,user=await currentUser(),days=Number(q.days),page=Math.min(39,Math.max(1,Math.trunc(Number(q.page))||1));
  const hits=searchPages(q.q??"",scopeFor(user),51,{space:q.space,kind:q.kind,owner:q.owner==="me"?user?.id:q.owner,since:days>0&&days<=3650?now()-days*86400_000:undefined,offset:(page-1)*50});
  const input="rounded-lg border border-line bg-bg p-2 text-sm";
  const next=(n:number)=>{const p=new URLSearchParams();for(const [k,v]of Object.entries(q))if(v)p.set(k,v);p.set("page",String(n));return `/search?${p}`;};
  return <div><SiteHeader/><main id="main" className="mx-auto max-w-4xl space-y-6 p-6"><h1 className="wordmark text-3xl">Search the library</h1><form className="grid gap-3 rounded-xl border border-line p-4 sm:grid-cols-2"><label className="sm:col-span-2">Search terms<input name="q" required defaultValue={q.q} className={`${input} w-full`} /></label><label>Space slug<input name="space" defaultValue={q.space} className={`${input} w-full`}/></label><label>Owner ID (or “me”)<input name="owner" defaultValue={q.owner} className={`${input} w-full`}/></label><label>Document collection<select name="kind" defaultValue={q.kind??""} className={`${input} w-full`}><option value="">All types</option>{["docs","wiki","articles","cookbook"].map(t=><option key={t}>{t}</option>)}</select></label><label>Updated within<select name="days" defaultValue={q.days??""} className={`${input} w-full`}><option value="">Any time</option><option value="7">7 days</option><option value="30">30 days</option><option value="180">180 days</option><option value="365">1 year</option></select></label><button className="rounded-lg bg-accent p-2 text-accent-ink">Search</button><Link href="/search" className="p-2 text-sm underline">Clear filters</Link></form><p className="text-sm text-muted">Only documents you can read are searched. Filters apply before ranking and pagination.</p>{q.q&&!hits.length&&<p>No matching documents. Try fewer filters.</p>}<ol className="space-y-5">{hits.slice(0,50).map(h=><li key={h.page_id}><Link href={`/${h.space_slug}/${h.page_slug}`} className="text-lg font-semibold [overflow-wrap:anywhere]">{h.title}</Link><p className="text-xs text-muted">{h.space_name}</p><p className="mt-1 text-sm [overflow-wrap:anywhere]" dangerouslySetInnerHTML={{__html:h.snippet}}/></li>)}</ol><nav className="flex gap-4">{page>1&&<Link href={next(page-1)}>Previous</Link>}{hits.length>50&&page<39&&<Link href={next(page+1)}>Next</Link>}</nav></main></div>;
}
