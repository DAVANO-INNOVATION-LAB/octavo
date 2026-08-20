"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Search } from "lucide-react";

type Hit = {
  page_id: string;
  title: string;
  snippet: string;
  space_slug: string;
  space_name: string;
  page_slug: string;
};

export function SearchButton() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="group flex h-8 items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-sm text-muted transition-colors hover:border-line-strong hover:text-ink"
      >
        <Search size={14} />
        <span className="hidden sm:inline">Search</span>
        <span className="kbd hidden sm:inline">⌘K</span>
      </button>
      {open && <SearchOverlay close={() => setOpen(false)} />}
    </>
  );
}

function SearchOverlay({ close }: { close: () => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [sel, setSel] = useState(0);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!q.trim()) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
          signal: ctrl.signal,
        });
        const data = await res.json();
        setHits(data.results ?? []);
        setSel(0);
      } catch {
        /* aborted */
      }
    }, 120);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  const go = useCallback(
    (hit: Hit) => {
      close();
      router.push(`/${hit.space_slug}/${hit.page_slug}`);
    },
    [close, router]
  );

  const shown = q.trim() ? hits : [];

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter" && shown[sel]) {
      go(shown[sel]);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="rise w-full max-w-xl overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search size={16} className="shrink-0 text-faint" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search all pages…"
            className="h-12 w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-faint"
          />
          <span className="kbd shrink-0">esc</span>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-2">
          {shown.length === 0 && q.trim() !== "" && (
            <p className="px-3 py-6 text-center text-sm text-faint">
              No pages match “{q}”
            </p>
          )}
          {shown.length === 0 && q.trim() === "" && (
            <p className="px-3 py-6 text-center text-sm text-faint">
              Type to search every published page
            </p>
          )}
          {shown.map((h, i) => (
            <button
              key={h.page_id}
              onClick={() => go(h)}
              onMouseEnter={() => setSel(i)}
              className={`flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                i === sel ? "bg-accent-soft" : ""
              }`}
            >
              <FileText size={15} className="mt-0.5 shrink-0 text-faint" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-ink">
                  {h.title}
                </span>
                <span
                  className="block truncate text-xs text-muted [&_mark]:font-semibold"
                  dangerouslySetInnerHTML={{ __html: h.snippet }}
                />
                <span className="mt-0.5 block text-[11px] text-faint">
                  {h.space_name}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
