"use client";

import { useState } from "react";
import Link from "next/link";
import { GripVertical, Lock } from "lucide-react";
import { Monogram } from "./Monogram";

export type ShelfSpace = {
  slug: string;
  name: string;
  description: string;
  kind: string;
  visibility: string;
  shelf: string;
  kindLabel: string;
  pageCount: number;
  updatedLabel: string;
};

/**
 * The shelves. Spaces group under named shelves; signed-in curators drag
 * books to reorder — dropping a book onto another shelf's card moves it to
 * that shelf. One page, curator's order — never pagination.
 */
export function LibraryGrid({
  spaces: initial,
  editing,
}: {
  spaces: ShelfSpace[];
  editing: boolean;
}) {
  const [spaces, setSpaces] = useState(initial);
  const [dragSlug, setDragSlug] = useState<string | null>(null);
  const [overSlug, setOverSlug] = useState<string | null>(null);

  // Groups in order of first appearance; unshelved books first.
  const groups: { shelf: string; items: ShelfSpace[] }[] = [];
  for (const s of spaces) {
    const g = groups.find((g) => g.shelf === s.shelf);
    if (g) g.items.push(s);
    else groups.push({ shelf: s.shelf, items: [s] });
  }
  groups.sort((a, b) => (a.shelf === "" ? -1 : b.shelf === "" ? 1 : 0));

  function commit(next: ShelfSpace[]) {
    setSpaces(next);
    fetch("/api/spaces/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        order: next.map((s) => ({ slug: s.slug, shelf: s.shelf })),
      }),
    }).catch(() => {});
  }

  function drop(targetSlug: string) {
    setOverSlug(null);
    const from = spaces.findIndex((s) => s.slug === dragSlug);
    const to = spaces.findIndex((s) => s.slug === targetSlug);
    setDragSlug(null);
    if (from < 0 || to < 0 || from === to) return;
    const next = spaces.slice();
    const [moved] = next.splice(from, 1);
    const target = spaces[to];
    const insertAt = next.findIndex((s) => s.slug === targetSlug);
    next.splice(insertAt + (from < to ? 1 : 0), 0, {
      ...moved,
      shelf: target.shelf,
    });
    commit(next);
  }

  return (
    <div className="space-y-10">
      {groups.map((g) => (
        <section key={g.shelf || "·"}>
          {g.shelf ? (
            <h2 className="mb-4 flex items-baseline gap-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
              {g.shelf}
              <span className="h-px flex-1 bg-line" aria-hidden />
            </h2>
          ) : (
            // The unshelved group has no visible heading, but its cards are
            // h3s — without this, the outline runs h1 straight to h3 and a
            // screen reader's heading navigation loses a level.
            <h2 className="sr-only">Shelf</h2>
          )}
          <div className="grid auto-rows-fr grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {g.items.map((s, i) => (
              <div
                key={s.slug}
                draggable={editing}
                onDragStart={() => setDragSlug(s.slug)}
                onDragEnd={() => {
                  setDragSlug(null);
                  setOverSlug(null);
                }}
                onDragOver={(e) => {
                  if (dragSlug === null) return;
                  e.preventDefault();
                  setOverSlug(s.slug);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  drop(s.slug);
                }}
                className={`h-full transition-all ${
                  dragSlug === s.slug ? "scale-[0.98] opacity-40" : ""
                } ${
                  overSlug === s.slug && dragSlug !== null && dragSlug !== s.slug
                    ? "translate-y-1 [&>a]:border-accent"
                    : ""
                }`}
              >
                <Link
                  href={`/${s.slug}`}
                  className="rise group relative flex h-full flex-col overflow-hidden rounded-xl border border-line bg-surface p-6 pl-7 shadow-card transition-all hover:-translate-y-0.5 hover:shadow-pop"
                  style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}
                  onClick={(e) => {
                    if (dragSlug !== null) e.preventDefault();
                  }}
                >
                  <span className="absolute inset-y-0 left-0 w-1.5 bg-accent/80 transition-all group-hover:w-2" />
                  {editing && (
                    <span
                      aria-hidden
                      title="Drag to reorder — drop on another shelf to move it there"
                      className="absolute right-3 top-3 cursor-grab text-faint opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
                    >
                      <GripVertical size={15} />
                    </span>
                  )}
                  <Monogram name={s.name} />
                  <h3 className="wordmark mt-3 flex items-start gap-2 text-xl leading-snug text-ink">
                    <span className="line-clamp-2 min-w-0">{s.name}</span>
                    {s.visibility === "private" && (
                      <Lock size={13} className="mt-1.5 shrink-0 text-faint" />
                    )}
                  </h3>
                  <p className="mt-1.5 line-clamp-2 min-h-[2.6em] text-sm leading-relaxed text-muted">
                    {s.description}
                  </p>
                  <p className="mt-auto pt-4 text-[11px] font-medium uppercase tracking-[0.1em] text-faint">
                    {s.kindLabel} · {s.pageCount}{" "}
                    {s.pageCount === 1 ? "page" : "pages"} · {s.updatedLabel}
                  </p>
                </Link>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
