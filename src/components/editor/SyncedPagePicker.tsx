"use client";

import { useEffect, useRef, useState } from "react";
import { FileInput, X } from "lucide-react";

/**
 * The editor face of an embedded page: pick the source, show a labelled
 * card. The content itself never renders here — a writer editing page A
 * must not scroll through page B's prose inline, and the reader-side
 * resolution happens on the server where permissions live.
 */

type Hit = { page_id: string; title: string; space_name: string };

export function SyncedPagePicker({
  pageId,
  title,
  onPick,
}: {
  pageId: string;
  title: string;
  onPick: (pageId: string, title: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      // Defer the clear: setting state synchronously in an effect body trips
      // React's cascading-render guard.
      const id = setTimeout(() => setHits([]), 0);
      return () => clearTimeout(id);
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/pages/lookup?q=${encodeURIComponent(query)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { pages: Hit[] };
        setHits(data.pages.slice(0, 6));
      } catch {
        /* the picker just stays empty */
      }
    }, 200);
  }, [query]);

  if (pageId) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-line bg-wash px-3 py-2.5">
        <FileInput size={15} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-sm text-ink">
          Embeds <strong className="font-medium">{title || "a page"}</strong>
          <span className="ml-2 text-xs text-faint">
            readers see its current content
          </span>
        </span>
        <button
          onClick={() => onPick("", "")}
          title="Remove the embed"
          className="shrink-0 text-faint hover:text-ink"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-dashed border-line p-3">
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-faint">
        <FileInput size={11} />
        Embed a page
      </p>
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search pages by title…"
        className="h-9 w-full rounded-md border border-line bg-bg px-3 text-sm text-ink outline-none placeholder:text-faint focus:border-accent"
      />
      {hits.length > 0 && (
        <ul className="mt-2 overflow-hidden rounded-md border border-line">
          {hits.map((h) => (
            <li key={h.page_id} className="border-b border-line last:border-0">
              <button
                onClick={() => onPick(h.page_id, h.title)}
                className="flex w-full items-baseline gap-2 px-3 py-2 text-left text-sm text-ink hover:bg-wash"
              >
                <span className="min-w-0 flex-1 truncate">{h.title}</span>
                <span className="shrink-0 text-xs text-faint">{h.space_name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
