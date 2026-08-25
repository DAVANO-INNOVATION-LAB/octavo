"use client";

import { useState } from "react";
import { Globe } from "lucide-react";

/**
 * Import a single page from the web. Client-side because the answer is JSON
 * with a destination, not a redirect — and a failed fetch should leave the
 * person on this form with the reason, not on an error page.
 */
export function UrlImport() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/import/url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = (await res.json()) as { spaceSlug?: string; error?: string };
      if (!res.ok || !data.spaceSlug) {
        setError(data.error ?? "import failed");
        setBusy(false);
        return;
      }
      window.location.href = `/${data.spaceSlug}`;
    } catch {
      setError("the fetch did not complete");
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={run}
      className="mt-6 space-y-4 rounded-2xl border border-line bg-surface p-8 shadow-card"
    >
      <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.08em] text-faint">
        <Globe size={13} />
        Or import from a URL
      </p>
      <input
        required
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://example.com/docs/page"
        className="h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none transition-colors placeholder:text-faint focus:border-accent"
      />
      {error && (
        <p className="rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">{error}</p>
      )}
      <button
        disabled={busy}
        className="h-10 w-full rounded-lg border border-line bg-bg text-sm font-medium text-ink transition-colors hover:border-line-strong disabled:opacity-60"
      >
        {busy ? "Fetching…" : "Fetch and import"}
      </button>
      <p className="text-xs leading-relaxed text-faint">
        The article content becomes one page in a new private space. The
        server only fetches public web addresses — never anything inside your
        own network.
      </p>
    </form>
  );
}
