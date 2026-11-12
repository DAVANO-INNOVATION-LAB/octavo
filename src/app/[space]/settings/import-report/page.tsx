import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Download, ArrowLeft, FileCheck2 } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { getSpaceBySlug, pageTree } from "@/lib/data";
import { canReadSpace, canAdminSpace } from "@/lib/roles";
import { getImportReport } from "@/lib/import-reports";
import { SpaceShell } from "@/components/SpaceShell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Import report" };

export default async function ImportReportPage({ params }: { params: Promise<{ space: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { space: slug } = await params;
  const space = getSpaceBySlug(slug);
  if (!space || !canReadSpace(user, space) || !canAdminSpace(user, space.id)) notFound();
  const report = getImportReport(user, space.id);
  const tree = pageTree(space.id, false);
  const metrics = report ? [
    ["Pages imported", report.counts.pages],
    ["Published", report.counts.published],
    ["Drafts", report.counts.drafts],
    ["Search indexed", report.counts.indexed],
    ["Attachments saved", report.counts.attachmentsSaved],
  ] as const : [];

  return <SpaceShell space={space} tree={tree} editing rail={null}>
    <div className="mx-auto max-w-3xl space-y-8 [overflow-wrap:anywhere]">
      <header>
        <Link href={`/${space.slug}`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-accent"><ArrowLeft size={14} aria-hidden />Back to space</Link>
        <p className="mt-7 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Space administration</p>
        <h1 className="wordmark mt-2 text-3xl text-ink">Import report</h1>
        <p className="mt-2 text-sm text-muted">{space.name}</p>
      </header>
      {!report ? <section className="rounded-2xl border border-dashed border-line p-6">
        <h2 className="text-lg font-semibold text-ink">No saved import report</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">This space has no recorded import summary. Reports are saved for new imports; historical counts have not been reconstructed.</p>
      </section> : <>
        <section aria-labelledby="import-completed" className="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 id="import-completed" className="flex items-center gap-2 font-semibold text-ink"><FileCheck2 size={18} aria-hidden />Import completed</h2>
              <p className="mt-2 text-sm text-muted"><time dateTime={new Date(report.completedAt).toISOString()}>{new Date(report.completedAt).toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC</time></p>
            </div>
            <a href={`/api/spaces/${space.slug}/import-report`} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm text-accent hover:border-accent"><Download size={15} aria-hidden />Download JSON</a>
          </div>
          <dl className="mt-5 grid gap-3 border-t border-line pt-4 text-sm sm:grid-cols-[7rem_1fr]">
            <dt className="text-faint">Source</dt><dd className="min-w-0 text-ink">{report.source.label}</dd>
            <dt className="text-faint">Import method</dt><dd className="text-ink">{report.source.kind === "openapi" ? "OpenAPI specification" : report.source.kind === "url" ? "URL import" : "File upload"}</dd>
          </dl>
        </section>
        <section aria-labelledby="import-counts">
          <h2 id="import-counts" className="text-lg font-semibold text-ink">What was saved</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">Snapshot at import completion, not current space totals. Search indexed means recorded in local search, not publicly visible.</p>
          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {metrics.map(([label, count]) => <div key={label} className="rounded-xl border border-line bg-surface p-4"><dt className="text-xs text-muted">{label}</dt><dd className="mt-2 text-3xl font-semibold tabular-nums text-ink">{count.toLocaleString("en-US")}</dd></div>)}
          </dl>
        </section>
        {report.preview && <section aria-labelledby="import-preview" className="rounded-xl border border-dashed border-line p-5">
          <h2 id="import-preview" className="font-semibold text-ink">Preview estimates</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">Before conversion: {report.preview.pages.toLocaleString("en-US")} pages and {report.preview.attachmentEntries.toLocaleString("en-US")} attachment entries. Estimates can differ from saved results and are not a count of successfully converted files.</p>
        </section>}
        <section aria-labelledby="import-warnings">
          <h2 id="import-warnings" className="text-lg font-semibold text-ink">Warnings <span className="ml-1 text-sm font-normal text-faint">({report.warnings.length})</span></h2>
          {report.warnings.length ? <ul className="mt-3 list-disc space-y-2 rounded-xl border border-line bg-surface py-4 pl-9 pr-5 text-sm leading-relaxed text-muted">{report.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul> : <p className="mt-2 text-sm text-muted">No warnings were recorded. This does not guarantee that every source detail was preserved.</p>}
        </section>
        <section aria-labelledby="import-notes" className="border-t border-line pt-6">
          <h2 id="import-notes" className="text-lg font-semibold text-ink">Conversion notes</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">Completion confirms the import was saved, not exact visual or behavioral fidelity. Review important pages, links, formatting, and attachments before relying on them.</p>
          {report.notes.length > 0 && <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-muted">{report.notes.map((note, i) => <li key={i}>{note}</li>)}</ul>}
        </section>
      </>}
    </div>
  </SpaceShell>;
}
