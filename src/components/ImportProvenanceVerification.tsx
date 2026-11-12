"use client";

import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw } from "lucide-react";

type Status = "unchanged" | "changed" | "missing" | "unavailable";
import type { ImportProvenanceVerificationResult as VerificationResult } from "@/lib/provenance-verification";
const labels: Record<Status, string> = { unchanged: "Unchanged", changed: "Changed", missing: "Missing", unavailable: "Unavailable" };

export function ImportProvenanceVerification({ slug }: { slug: string }) {
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);

  async function verify() {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    setResult(null); setError(""); setBusy(true);
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(`/api/spaces/${encodeURIComponent(slug)}/import-report/verify`, {
        method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal,
      });
      if (!response.ok) throw new Error(response.status === 404 ? "This report is no longer available or you no longer have permission to check it." : "The check could not be completed. Try again.");
      const value = await response.json() as VerificationResult;
      if (!["checked", "unavailable"].includes(value.status) || !Number.isFinite(value.checkedAt) || !Number.isFinite(new Date(value.checkedAt).getTime()) || !Array.isArray(value.pages) || !Array.isArray(value.attachments) || !value.counts || value.source?.status !== "not_checked" || !Object.keys(labels).every(status => Number.isSafeInteger(value.counts[status as Status]) && value.counts[status as Status] >= 0) || ![...value.pages, ...value.attachments].every(item => item && Object.hasOwn(labels, item.status))) throw new Error("The check returned an unexpected response. Try again.");
      if (active.current === controller) setResult(value);
    } catch (cause) {
      if (active.current !== controller) return;
      setError(cause instanceof Error && cause.name === "AbortError" ? "The check timed out or was interrupted. Try again." : cause instanceof Error ? cause.message : "The check could not be completed. Try again.");
    } finally { clearTimeout(timer); if (active.current === controller) { active.current = null; setBusy(false); } }
  }
  function download() {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2) + "\n"], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "octavo-provenance-verification.json";
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const rows = result ? [...result.pages.map(page => ({ ...page, key: `page:${page.pageId}`, label: `Page ${page.pageId}` })), ...result.attachments.map(file => ({ ...file, key: `file:${file.name}`, label: `Attachment ${file.name}` }))] : [];
  const changedRows = rows.filter(row => row.status !== "unchanged");
  const visibleRows = changedRows.slice(0, 50);
  return <section aria-labelledby="verify-recorded-heading" data-testid="provenance-verification" className="mt-6 border-t border-line pt-5">
    <h3 id="verify-recorded-heading" className="font-semibold text-ink">Check recorded outputs</h3>
    <p className="mt-2 text-sm leading-relaxed text-muted">Compare the pages and attachments recorded in this receipt with their current stored content. Nothing is checked until you request it. This does not verify the original upload, newly added content or authenticity. A legitimate edit can produce a changed result; changed does not mean corrupted.</p>
    <button type="button" onClick={verify} disabled={busy} data-testid="verify-provenance" className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-lg border border-accent px-3 py-2 text-sm text-accent disabled:opacity-60"><RefreshCw size={15} aria-hidden className={busy ? "animate-spin" : ""} />{busy ? "Checking recorded outputs…" : result || error ? "Check again" : "Check recorded outputs"}</button>
    <div aria-live="polite" aria-atomic="true" className="mt-3 text-sm" data-testid="verification-status">
      {busy && <p role="status" className="text-muted">Checking current content. Previous results have been cleared.</p>}
      {error && <p role="alert" className="rounded-lg border border-line p-3 text-ink">{error} No previous result is shown.</p>}
      {result && <div data-testid="verification-result" className="space-y-4">
        <p className="text-muted">Checked <time dateTime={new Date(result.checkedAt).toISOString()}>{new Date(result.checkedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC</time>. Results are a point-in-time comparison and are not saved to the report.</p>
        {result.status === "unavailable" ? <p className="rounded-lg border border-line p-3 text-ink">Verification unavailable: {result.reason || "No usable provenance baseline is recorded."}</p> : <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">{(Object.keys(labels) as Status[]).map(status => <div key={status} className="rounded-lg border border-line p-3"><dt className="text-xs text-muted">{labels[status]}</dt><dd className="mt-1 text-2xl font-semibold tabular-nums text-ink" data-testid={`count-${status}`}>{result.counts[status].toLocaleString("en-US")}</dd></div>)}</dl>
          <p className="text-muted">{result.scope}</p>
          {visibleRows.length ? <><h4 className="font-medium text-ink">Changed, missing or unavailable outputs</h4><ul className="space-y-2">{visibleRows.map(row => <li key={row.key} className="min-w-0 rounded-lg border border-line p-3 [overflow-wrap:anywhere]"><strong>{labels[row.status]}</strong><span className="ml-2 font-mono text-xs">{row.label}</span>{row.reason && <p className="mt-1 text-muted">{row.reason}</p>}</li>)}</ul>{changedRows.length > visibleRows.length && <p className="text-muted">Showing the first 50 exceptions. Download JSON for all recorded results.</p>}</> : <p className="text-muted">No differences were found among the recorded outputs checked. This is not a check of everything in the space.</p>}
        </>}
        <p className="text-muted">Original upload not checked: {result.source.reason}</p>
        <button type="button" onClick={download} data-testid="download-verification" className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm text-accent"><Download size={15} aria-hidden />Download verification JSON</button>
      </div>}
    </div>
  </section>;
}
