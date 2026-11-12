"use client";

import { useRef, useState } from "react";
import type { ImportPreview } from "@/lib/import-preview";

function readableBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString("en-US")} bytes`;
  const unit = bytes >= 1024 * 1024 ? "MiB" : "KiB";
  const divisor = unit === "MiB" ? 1024 * 1024 : 1024;
  return `${(bytes / divisor).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${unit} (${bytes.toLocaleString("en-US")} bytes)`;
}

export function ImportPreviewForm() {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const keyInput = useRef<HTMLInputElement>(null);
  const keyRef = useRef("");
  const [submissionKey, setSubmissionKey] = useState("");
  function rotateKey(): boolean {
    try {
      if (!keyInput.current) return false;
      keyRef.current = ""; keyInput.current.value = ""; setSubmissionKey("");
      const nextKey = typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
      keyRef.current = nextKey; keyInput.current.value = nextKey; setSubmissionKey(nextKey);
      return true;
    } catch {
      setError("Secure random generation is unavailable in this browser. Use a supported browser or a secure connection before importing.");
      return false;
    }
  }

  return <form action="/api/import" method="post" encType="multipart/form-data" className="mt-8 min-w-0 space-y-5 rounded-2xl border border-line bg-surface p-5 sm:p-6 [overflow-wrap:anywhere]" onSubmit={async e => {
    if (!keyRef.current && !rotateKey()) { e.preventDefault(); return; }
    if (preview && !preview.errors.length) return;
    e.preventDefault();
    const request = ++sequence.current;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/import/preview", { method: "POST", body: new FormData(e.currentTarget) });
      const body = await response.json();
      if (request !== sequence.current) return;
      if (!response.ok) throw new Error(body.error);
      setPreview(body);
    } catch (e) {
      if (request === sequence.current) setError(e instanceof Error ? e.message : "Preview failed");
    } finally {
      if (request === sequence.current) setBusy(false);
    }
  }}>
    <input ref={keyInput} type="hidden" name="idempotencyKey" value={submissionKey} readOnly />
    <label className="block text-sm font-medium text-ink">
      File
      <input type="file" name="file" required accept=".zip,.md,.markdown,.txt,.json,.docx,.ipynb" className="mt-2 block w-full min-w-0 text-sm" onChange={() => {
        sequence.current++; setPreview(null); setError(""); setBusy(false); rotateKey();
      }} />
    </label>
    <label className="block text-sm font-medium text-ink">
      Space name <span className="font-normal text-muted">(optional)</span>
      <input name="name" onChange={() => { setError(""); rotateKey(); }} className="mt-2 w-full rounded-lg border border-line bg-bg p-2.5" />
    </label>
    <div className="rounded-xl border border-line bg-bg p-4 text-sm text-muted" data-testid="import-retry-guidance">
      <p>Retrying this unchanged submission uses the same import attempt, so a completed attempt returns its original space instead of creating another. Changing the file or space name starts a new attempt.</p>
      <p className="mt-2 text-xs leading-relaxed">This is retry protection, not duplicate-file detection. A fresh page or a separate attempt can create another space. Keep the same submission when retrying an uncertain result.</p>
      <button type="button" disabled={busy} onClick={() => { sequence.current++; setPreview(null); setError(""); rotateKey(); }} className="mt-3 min-h-10 rounded-lg border border-line px-3 py-2 text-xs text-accent disabled:opacity-50" data-testid="separate-import">Start a separate import</button>
    </div>
    {error && <p role="alert" className="rounded-lg border border-line p-3 text-sm">{error}</p>}
    {preview && <section aria-labelledby="import-preview-heading" className="space-y-4 border-t border-line pt-5">
      <div>
        <h2 id="import-preview-heading" className="text-lg font-semibold text-ink">Import preview</h2>
        <p role="status" className="mt-1 text-sm text-muted">Nothing has been imported yet.</p>
      </div>
      <dl className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-line bg-bg p-3">
          <dt className="text-xs leading-relaxed text-muted">Preview pages</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums text-ink">{preview.pages.length.toLocaleString("en-US")}</dd>
        </div>
        <div className="rounded-xl border border-line bg-bg p-3">
          <dt className="text-xs leading-relaxed text-muted">Attachment-entry estimate</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums text-ink">{preview.attachments.toLocaleString("en-US")}</dd>
        </div>
      </dl>
      <div role="region" aria-labelledby="import-asset-plan-heading" className="rounded-xl border border-line bg-bg p-4">
        <h3 id="import-asset-plan-heading" className="text-sm font-semibold text-ink">Referenced asset copy plan</h3>
        {preview.assetPlan ? <>
          <p data-testid="import-asset-plan-files" className="mt-2 text-sm text-ink">{preview.assetPlan.files.toLocaleString("en-US")} referenced {preview.assetPlan.files === 1 ? "file" : "files"} planned for copying</p>
          <p data-testid="import-asset-plan-bytes" className="mt-1 text-sm tabular-nums text-muted">{readableBytes(preview.assetPlan.bytes)} total planned</p>
          <p className="mt-2 text-xs leading-relaxed text-muted">For this Markdown/Notion ZIP, the plan counts distinct bundled files referenced by parsed content, not every archive entry. Files have not been written. A plan is not a guarantee that every source detail will be preserved.</p>
        </> : <p className="mt-2 text-sm leading-relaxed text-muted">A referenced-asset copy plan is not available for this preview. This does not mean zero attachments will be saved. Review the import report after completion for actual results.</p>}
      </div>
      <details>
        <summary className="cursor-pointer text-sm font-medium text-ink">Preview page list ({preview.pages.length.toLocaleString("en-US")})</summary>
        {preview.pages.some(page => page.parentIndex !== undefined) && <p className="mt-3 text-xs leading-relaxed text-muted">This Markdown/Notion plan includes generated folder pages, actual titles and publication states. Page addresses are assigned when you confirm. Other import formats may show estimates rather than this detailed structure.</p>}
        <ol aria-label="Planned imported pages" className="mt-3 max-h-96 space-y-3 overflow-auto rounded-lg border border-line p-3 text-sm text-muted">{preview.pages.map((page, i) => {
          const hasStructure = typeof page.published === "boolean" && page.parentIndex !== undefined;
          const parent = typeof page.parentIndex === "number" ? preview.pages[page.parentIndex] : undefined;
          let depth = 0;
          let ancestor = page.parentIndex;
          const seen = new Set<number>([i]);
          while (typeof ancestor === "number" && preview.pages[ancestor] && !seen.has(ancestor)) {
            seen.add(ancestor); depth++; ancestor = preview.pages[ancestor].parentIndex;
          }
          return <li key={i} data-testid="import-page-plan-row" className="min-w-0 rounded-lg border border-line bg-bg p-3" style={{ marginLeft: `${Math.min(depth, 3) * 0.5}rem` }}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-ink">{page.title}</span>
              {hasStructure && <span className="rounded-full border border-line px-2 py-0.5 text-xs text-ink">{page.published ? "Published" : "Draft"}</span>}
              {page.generated && <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">Generated folder</span>}
            </div>
            {hasStructure && <p className="mt-1 text-xs leading-relaxed"><span className="sr-only">Hierarchy level {depth + 1}. </span>{parent ? `Parent: ${parent.title}` : "Top-level page"}</p>}
            {page.sourcePath && <p className="mt-2 break-all text-xs leading-relaxed">Source: <code>{page.sourcePath}</code></p>}
            {page.generated && <p className="mt-2 text-xs leading-relaxed">Created to contain pages from this folder; no source document.</p>}
            <p className="mt-1 text-xs text-faint">{page.blocks} blocks</p>
          </li>;
        })}</ol>
      </details>
      {preview.warnings.length > 0 && <div>
        <h3 className="text-sm font-semibold text-ink">Review warnings ({preview.warnings.length})</h3>
        <ul className="mt-2 list-disc space-y-2 pl-5 text-sm leading-relaxed text-muted">{preview.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>
      </div>}
      {preview.errors.length > 0 && <div role="alert" className="rounded-lg border border-line p-3 text-sm">
        <h3 className="font-semibold">Resolve these issues before importing</h3>
        <ul className="mt-2 list-disc space-y-2 pl-5">{preview.errors.map((issue, i) => <li key={i}>{issue}</li>)}</ul>
      </div>}
      <p id="import-confirmation-guidance" className="text-xs leading-relaxed text-muted">Review the estimates, copy plan and warnings before confirming. Conversion may simplify formatting or omit unsupported features. Confirmation creates a new private space; review its saved import report and important pages afterward.</p>
      <input type="hidden" name="previewDigest" value={preview.digest} />
    </section>}
    <button disabled={busy || Boolean(preview?.errors.length)} aria-describedby={preview ? "import-confirmation-guidance" : undefined} className="w-full rounded-lg bg-accent p-3 text-sm font-medium text-accent-ink disabled:opacity-50">{busy ? "Checking import…" : preview ? "Confirm and import" : "Preview import"}</button>
  </form>;
}
