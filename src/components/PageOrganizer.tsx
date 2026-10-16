"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { GripVertical } from "lucide-react";
import type { TreeNode } from "@/lib/data";

type Floating = { page: TreeNode; x: number; y: number; width: number; height: number; groupHeight: number };
type Drop = { targetId: string; placement: "before" | "after" };

export function PageOrganizer({ tree, space }: { tree: TreeNode[]; space: string }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [refreshing, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [floating, setFloating] = useState<Floating | null>(null);
  const geometry = useRef<{ offsetX: number; offsetY: number; scrollY: number; height: number; left: number; right: number; rows: { id: string; top: number; height: number }[] } | null>(null);
  const destination = useRef<Drop | null>(null);
  const busy = saving || refreshing;
  function clearDrag() { setDragging(null); setDrop(null); setFloating(null); geometry.current = null; destination.current = null; }
  async function move(page: TreeNode, change: Drop | { direction: "up" | "down" }) {
    setSaving(true); setMessage("");
    try {
      const res = await fetch("/api/pages/order", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ space, pageId: page.id, ...change }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Unable to save order.");
      setMessage(`Order saved. Moved ${page.title}.`);
      startTransition(() => router.refresh());
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to save order. Try again."); }
    finally { setSaving(false); }
  }
  function rows(nodes: TreeNode[]) {
    const from = nodes.findIndex(p => p.id === dragging);
    let to = from;
    if (from >= 0 && drop) {
      const remaining = nodes.filter(p => p.id !== dragging);
      const target = remaining.findIndex(p => p.id === drop.targetId);
      if (target >= 0) to = target + (drop.placement === "after" ? 1 : 0);
    }
    const distance = floating?.groupHeight ?? 0;
    return <ol className="space-y-2">{nodes.map((page, index) => <li key={page.id}
      data-order-item={page.id}
      style={{ transform: `translateY(${from >= 0 && index > from && index <= to ? -distance : from >= 0 && index < from && index >= to ? distance : 0}px)` }}
      className={`relative ${dragging === page.id ? "opacity-0" : "transition-transform duration-150 motion-reduce:transition-none"}`}>
      <div data-order-page={page.id} data-order-parent={page.parent_id ?? ""}
        className={`relative flex items-center gap-3 rounded-lg border bg-surface p-3 ${dragging === page.id ? "border-accent opacity-50" : "border-line"}`}>
        <button type="button" aria-label={`Reorder ${page.title}`} aria-describedby="order-help"
          disabled={busy} title="Drag to reorder; use arrow keys when focused"
          className="touch-none select-none rounded p-2 text-muted hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-30 cursor-grab active:cursor-grabbing"
          onPointerDown={event => {
            if (busy || event.button !== 0) return;
            const row = event.currentTarget.closest<HTMLElement>("[data-order-page]")!;
            const item = row.parentElement!;
            const bounds = row.getBoundingClientRect();
            geometry.current = {
              offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top,
              scrollY: window.scrollY, height: item.getBoundingClientRect().height + 8,
              left: bounds.left, right: bounds.right,
              rows: Array.from(item.parentElement!.children).map(el => {
                const rect = el.getBoundingClientRect();
                return { id: (el as HTMLElement).dataset.orderItem!, top: rect.top, height: rect.height };
              }),
            };
            setFloating({ page, x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height, groupHeight: item.getBoundingClientRect().height + 8 });
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragging(page.id); setMessage(`Moving ${page.title}. Drop within this section.`);
          }}
          onPointerMove={event => {
            if (dragging !== page.id || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const layout = geometry.current;
            if (!layout) return;
            setFloating(current => current && ({ ...current, x: event.clientX - layout.offsetX, y: event.clientY - layout.offsetY }));
            const others = layout.rows.filter(row => row.id !== page.id);
            const y = event.clientY + window.scrollY - layout.scrollY;
            const nextRow = others.find(row => y < row.top + row.height / 2);
            let next: Drop | null = null;
            if (event.clientX >= layout.left - 40 && event.clientX <= layout.right + 40 && others.length) {
              next = nextRow ? { targetId: nextRow.id, placement: "before" } : { targetId: others[others.length - 1].id, placement: "after" };
            }
            destination.current = next; setDrop(next);
            if (event.clientY < 80) window.scrollBy(0, -16);
            else if (event.clientY > window.innerHeight - 80) window.scrollBy(0, 16);
          }}
          onPointerUp={event => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const target = destination.current;
            clearDrag(); event.currentTarget.releasePointerCapture(event.pointerId);
            if (target) void move(page, target); else setMessage("Order unchanged.");
          }}
          onPointerCancel={() => { clearDrag(); setMessage("Move cancelled."); }}
          onLostPointerCapture={clearDrag}
          onKeyDown={event => {
            if (event.key === "Escape") { clearDrag(); setMessage("Move cancelled."); event.currentTarget.blur(); return; }
            if (!busy && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
              event.preventDefault();
              if ((event.key === "ArrowUp" && index > 0) || (event.key === "ArrowDown" && index < nodes.length - 1))
                void move(page, { direction: event.key === "ArrowUp" ? "up" : "down" });
            }
          }}><GripVertical size={20} /></button>
        <span className="min-w-0 flex-1 break-words text-sm">{page.title}{!page.published && <span className="ml-2 text-xs text-faint">Draft</span>}</span>
        <span aria-hidden="true" className="text-xs tabular-nums text-faint">{index + 1}</span>
      </div>
      {page.children.length > 0 && <div className="mt-2 border-l border-line pl-4 sm:pl-6">{rows(page.children)}</div>}
    </li>)}</ol>;
  }
  return <div aria-busy={busy}>
    <p id="order-help" className="mb-2 text-xs text-muted">Drag the grip to move a document. With the grip focused, use ↑ or ↓ to reorder.</p>
    <p role="status" className="mb-3 min-h-5 text-sm text-muted">{busy ? "Saving order…" : message}</p>
    {tree.length ? rows(tree) : <p>No pages yet. Add or import a document to get started.</p>}
    {floating && <div aria-hidden="true" data-drag-preview
      className="pointer-events-none fixed z-50 flex items-center gap-3 rounded-lg border border-accent bg-surface p-3 shadow-2xl ring-2 ring-accent/20"
      style={{ left: 0, top: 0, width: floating.width, minHeight: floating.height, transform: `translate3d(${floating.x}px, ${floating.y}px, 0) rotate(1deg)` }}>
      <span className="p-2 text-accent"><GripVertical size={20} /></span>
      <span className="min-w-0 flex-1 break-words text-sm">{floating.page.title}{!floating.page.published && <span className="ml-2 text-xs text-faint">Draft</span>}</span>
      {floating.page.children.length > 0 && <span className="text-xs text-muted">Includes nested pages</span>}
    </div>}
  </div>;
}
