import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getSpaceBySlug } from "@/lib/data";
import { may } from "@/lib/roles";
import { SiteHeader } from "@/components/SiteHeader";
import { importBenchmarkAction } from "@/app/actions";

export const dynamic = "force-dynamic";
export default async function Benchmarks({params,searchParams}: {params:Promise<{space:string}>;searchParams:Promise<{error?:string}>}) {
  const space=getSpaceBySlug((await params).space); if(!space) notFound();
  const user=await currentUser(); if(!user) redirect("/login");
  if(!may(user,space.id,"write")) notFound();
  const {error}=await searchParams;
  const input="mt-1 block w-full rounded-lg border border-line bg-bg p-2 text-sm";
  return <><SiteHeader/><main id="main" className="mx-auto w-full max-w-3xl px-6 py-10">
    <h1 className="wordmark text-3xl">Add technical benchmarks</h1>
    <p className="mt-3 text-muted">Import CSV measurements from Grafana, GPU profiling tools or another exporter into an editable benchmark report. This saves a snapshot; the source dashboard remains a link, with its own sign-in.</p>
    {error && <p role="alert" className="mt-4 text-accent">{error}</p>}
    <form action={importBenchmarkAction} className="mt-6 space-y-5">
      <input type="hidden" name="space" value={space.slug}/>
      <label className="block">Report title<input name="title" required maxLength={200} className={input} placeholder="GPU inference benchmark"/></label>
      <label className="block">Dashboard or source URL (optional)<input name="source" type="url" className={input} placeholder="https://grafana.example.com/d/..."/><span className="text-xs text-muted">Use a normal dashboard link, without access tokens or other secrets.</span></label>
      <label className="block">Test conditions<textarea name="conditions" maxLength={4000} className={input} placeholder="GPU model/count, driver, workload, batch size, duration and collection time"/></label>
      <label className="block">CSV file<input type="file" name="file" accept=".csv,text/csv" required className={input}/></label>
      <p className="text-xs text-muted">Include column headers, for example: timestamp, gpu, utilization_percent, memory_mib, power_watts. Up to 500 data rows, 24 columns and 1 MB. In Grafana use Inspect → Data → Download CSV. Large runs should be summarized before uploading.</p>
      <button className="rounded-lg bg-accent px-4 py-2 text-accent-ink">Create benchmark report</button>
    </form>
  </main></>;
}
