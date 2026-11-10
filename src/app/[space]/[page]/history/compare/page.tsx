import Link from "next/link";
import { notFound,redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canEditSpace } from "@/lib/roles";
import { getSpaceBySlug,getPageBySlug,getVersion,listVersions } from "@/lib/data";
import { parseBlocks } from "@/lib/blocks";
import { blocksToMarkdown } from "@/lib/markdown";
import { readableBlocks } from "@/lib/quality-core";
import { diffLines } from "@/lib/diff";
export const dynamic="force-dynamic";
export default async function Compare({params,searchParams}:{params:Promise<{space:string;page:string}>;searchParams:Promise<{from?:string;to?:string;structure?:string}>}) {
 const user=await currentUser(); if(!user) redirect('/login');
 const path=await params, query=await searchParams, space=getSpaceBySlug(path.space);
 if(!space||!canEditSpace(user,space.id)) notFound();
 const page=getPageBySlug(space.id,path.page); if(!page) notFound();
 const versions=listVersions(page.id);
 const resolve=(id:string|undefined)=>{if(!id||id==='current')return page;const v=getVersion(id);if(!v||v.page_id!==page.id)notFound();return v;};
 const from=query.from||versions[0]?.id||'current',to=query.to||'current',a=resolve(from),b=resolve(to);
 const render=(p:typeof a)=>p.title+'\n\n'+(query.structure?readableBlocks(p.content):blocksToMarkdown(parseBlocks(p.content)));
 const rows=diffLines(render(a),render(b));
 return <main id="main" className="mx-auto max-w-5xl p-6"><Link href={`/${space.slug}/${page.slug}/history`}>← History</Link><h1 className="my-6 text-2xl [overflow-wrap:anywhere]">Compare versions — {page.title}</h1>
 <form className="mb-6 flex flex-wrap gap-4">{(['from','to'] as const).map(key=><label className="min-w-0 max-w-full" key={key}>{key==='from'?'Before':'After'} <select name={key} defaultValue={key==='from'?from:to} className="max-w-full border p-2"><option value="current">Current</option>{versions.map(v=><option key={v.id} value={v.id}>{new Date(v.saved_at).toLocaleString()} — {v.title}</option>)}</select></label>)}<label><input type="checkbox" name="structure" value="1" defaultChecked={!!query.structure}/> Include block properties</label><button className="rounded bg-accent px-4 text-accent-ink">Compare</button></form>
 <p className="mb-4 text-sm text-muted">− removed · + added. Block properties include media, tables, and diagrams.</p>
 <div className="overflow-auto rounded border border-line font-mono text-sm">{rows.map((r,i)=><pre key={i} className={`whitespace-pre-wrap px-3 py-0.5 ${r.kind==='add'?'bg-green-100 text-green-950':r.kind==='del'?'bg-red-100 text-red-950':''}`}>{r.kind==='add'?'+ '+r.b:r.kind==='del'?'− '+r.a:'  '+r.a}</pre>)}</div></main>;
}
