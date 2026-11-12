import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, ArrowRight, FileClock, FolderOpen } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { listImportReports } from "@/lib/import-reports";
import { SiteHeader } from "@/components/SiteHeader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Recent imports" };
const PAGE_SIZE = 20;
const MAX_PAGE = 1000;
const sourceLabels = { upload: "File upload", url: "URL import", openapi: "OpenAPI specification" };

export default async function ImportHistoryPage({ searchParams }: { searchParams: Promise<{ page?: string | string[] }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { page: requested } = await searchParams;
  const parsed = typeof requested === "string" && /^\d+$/.test(requested) ? Number(requested) : 1;
  const page = Number.isSafeInteger(parsed) ? Math.min(MAX_PAGE, Math.max(1, parsed)) : 1;
  const history = listImportReports(user, { offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE });
  const href = (target: number) => target === 1 ? "/import/history" : `/import/history?page=${target}`;

  return <div className="flex min-h-screen flex-col">
    <SiteHeader />
    <main id="main" className="mx-auto w-full min-w-0 max-w-3xl flex-1 space-y-7 px-4 py-10 sm:px-6 [overflow-wrap:anywhere]">
      <header>
        <Link href="/import" className="inline-flex min-h-10 items-center gap-1.5 text-sm text-accent"><ArrowLeft size={14} aria-hidden />Import a file or URL</Link>
        <h1 className="wordmark mt-4 text-3xl text-ink">Recent imports</h1>
        <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted">Completion reports for spaces you can currently read and administer, newest first. These snapshots describe what was saved at import time, not the current space inventory.</p>
      </header>
      {history.items.length === 0 ? <section aria-labelledby="import-history-empty" className="rounded-2xl border border-dashed border-line bg-surface p-6 sm:p-8">
        <FileClock size={24} className="text-faint" aria-hidden />
        <h2 id="import-history-empty" className="mt-4 text-lg font-semibold text-ink">No import reports to show</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">{page > 1 ? "There are no accessible reports on this page. Try newer imports or return to the first page." : "Reports appear here after new imports into spaces you administer. Older imports without saved reports are not reconstructed."}</p>
        <Link href="/import" className="mt-5 inline-flex min-h-10 items-center gap-2 rounded-lg border border-line px-4 py-2 text-sm text-accent">Start an import<ArrowRight size={14} aria-hidden /></Link>
        {page > 1 && <Link href="/import/history" className="mt-3 block text-sm text-accent underline underline-offset-4">Back to latest imports</Link>}
      </section> : <ol aria-label="Import completion reports" className="space-y-4">
        {history.items.map(({ report, space }) => <li key={report.id}>
          <article aria-labelledby={`report-${report.id}`} className="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">{sourceLabels[report.source.kind]}</p>
              <time dateTime={new Date(report.completedAt).toISOString()} className="text-xs text-muted">{new Date(report.completedAt).toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC</time>
            </div>
            <h2 id={`report-${report.id}`} className="mt-3 text-lg font-semibold text-ink">{space.name}</h2>
            <p className="mt-1 text-sm text-muted">Source: {report.source.label}</p>
            <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-line pt-4">
              <div><dt className="text-xs leading-relaxed text-muted">Pages saved</dt><dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{report.counts.pages.toLocaleString("en-US")}</dd></div>
              <div><dt className="text-xs leading-relaxed text-muted">Attachments saved</dt><dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{report.counts.attachmentsSaved.toLocaleString("en-US")}</dd></div>
              <div><dt className="text-xs leading-relaxed text-muted">Warnings recorded</dt><dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{report.warnings.length.toLocaleString("en-US")}</dd></div>
            </dl>
            <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2">
              <Link href={`/${space.slug}/settings/import-report`} aria-label={`View report for ${space.name}`} className="inline-flex min-h-10 items-center gap-1.5 text-sm font-medium text-accent">View report<ArrowRight size={14} aria-hidden /></Link>
              <Link href={`/${space.slug}`} aria-label={`Open space ${space.name}`} className="inline-flex min-h-10 items-center gap-1.5 text-sm text-muted hover:text-accent"><FolderOpen size={14} aria-hidden />Open space</Link>
            </div>
          </article>
        </li>)}
      </ol>}
      {(page > 1 || history.hasMore) && <nav aria-label="Import history pages" className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-sm">
        {page > 1 ? <Link href={href(page - 1)} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-line px-3 text-accent"><ArrowLeft size={14} aria-hidden />Newer</Link> : <span />}
        <span className="text-muted">Page {page.toLocaleString("en-US")}</span>
        {history.hasMore && page < MAX_PAGE ? <Link href={href(page + 1)} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-line px-3 text-accent">Older<ArrowRight size={14} aria-hidden /></Link> : <span />}
      </nav>}
      <p className="text-xs leading-relaxed text-faint">A completed import, or zero recorded warnings, does not guarantee that every source detail was preserved. Review the full report and important content before relying on it.</p>
    </main>
  </div>;
}
