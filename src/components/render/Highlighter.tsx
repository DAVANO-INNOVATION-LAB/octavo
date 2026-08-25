"use client";

import { useEffect, useRef, useState } from "react";
import { Highlighter as HighlighterIcon } from "lucide-react";

/**
 * Select a passage, keep it.
 *
 * Selecting text inside a passage offers one small button; pressing it saves
 * the highlight and paints it. On every later visit the reader's own
 * highlights are painted back. Clicking a painted highlight removes it.
 *
 * Painting wraps exact text matches in <mark> without disturbing React:
 * the walk happens after hydration, only touches text nodes, and unwrapping
 * restores the original node structure before anything else reads it.
 */

type Stored = { id: string; block_id: string; text: string };

function findRangeIn(el: Element, text: string): Range | null {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  // Build the concatenated text with node offsets so a phrase spanning
  // inline formatting (bold, links) is still found.
  const nodes: { node: Text; start: number }[] = [];
  let all = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n as Text, start: all.length });
    all += n.textContent ?? "";
  }
  const at = all.indexOf(text);
  if (at === -1) return null;
  const end = at + text.length;
  const locate = (offset: number, preferEnd: boolean) => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const { node, start } = nodes[i];
      const len = node.textContent?.length ?? 0;
      if (offset > start || (offset === start && (!preferEnd || i === 0)))
        return { node, offset: Math.min(offset - start, len) };
    }
    return { node: nodes[0].node, offset: 0 };
  };
  const from = locate(at, false);
  const to = locate(end, true);
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

function paint(el: Element, text: string, id: string): boolean {
  const range = findRangeIn(el, text);
  if (!range) return false;
  const mark = document.createElement("mark");
  mark.dataset.hl = id;
  mark.className = "octavo-hl";
  try {
    range.surroundContents(mark);
    return true;
  } catch {
    // The range crosses element boundaries; wrap each text piece instead.
    const frag = range.extractContents();
    const wrap = document.createElement("mark");
    wrap.dataset.hl = id;
    wrap.className = "octavo-hl";
    wrap.appendChild(frag);
    range.insertNode(wrap);
    return true;
  }
}

function unpaint(id: string) {
  for (const mark of document.querySelectorAll(`mark[data-hl="${CSS.escape(id)}"]`)) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
}

export function Highlighter({ pageId }: { pageId: string }) {
  const [button, setButton] = useState<{ x: number; y: number } | null>(null);
  const pending = useRef<{ blockId: string; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/highlights?page=${pageId}`);
        if (!res.ok) return;
        const { highlights } = (await res.json()) as { highlights: Stored[] };
        if (cancelled) return;
        for (const h of highlights) {
          const el = document.querySelector(`[data-blk="${CSS.escape(h.block_id)}"]`);
          if (el) paint(el, h.text, h.id);
        }
      } catch {
        /* highlights are an enhancement; the page reads fine without them */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  useEffect(() => {
    const onSelect = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        setButton(null);
        return;
      }
      const text = sel.toString().trim();
      if (text.length < 3 || text.length > 2000) {
        setButton(null);
        return;
      }
      const anchor =
        sel.anchorNode instanceof Element
          ? sel.anchorNode
          : sel.anchorNode?.parentElement;
      const blockEl = anchor?.closest("[data-blk]");
      if (!blockEl) {
        setButton(null);
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      pending.current = {
        blockId: (blockEl as HTMLElement).dataset.blk!,
        text,
      };
      setButton({
        x: rect.left + rect.width / 2 + window.scrollX,
        y: rect.top + window.scrollY - 40,
      });
    };

    const onClick = async (e: MouseEvent) => {
      const mark = (e.target as HTMLElement).closest?.("mark[data-hl]");
      if (mark instanceof HTMLElement && mark.dataset.hl) {
        const id = mark.dataset.hl;
        unpaint(id);
        fetch(`/api/highlights?id=${encodeURIComponent(id)}`, {
          method: "DELETE",
        }).catch(() => {});
      }
    };

    document.addEventListener("selectionchange", onSelect);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("selectionchange", onSelect);
      document.removeEventListener("click", onClick);
    };
  }, [pageId]);

  const save = async () => {
    const p = pending.current;
    setButton(null);
    if (!p) return;
    window.getSelection()?.removeAllRanges();
    try {
      const res = await fetch("/api/highlights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageId, blockId: p.blockId, text: p.text }),
      });
      if (!res.ok) return;
      const { id } = (await res.json()) as { id: string };
      const el = document.querySelector(`[data-blk="${CSS.escape(p.blockId)}"]`);
      if (el && id) paint(el, p.text, id);
    } catch {
      /* the selection simply stays unhighlighted */
    }
  };

  if (!button) return null;
  return (
    <button
      onMouseDown={(e) => {
        // Fire before selectionchange clears the pending selection.
        e.preventDefault();
        void save();
      }}
      style={{ position: "absolute", left: button.x, top: button.y, transform: "translateX(-50%)" }}
      className="z-40 flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-xs font-medium text-ink shadow-pop"
      aria-label="Highlight this passage"
    >
      <HighlighterIcon size={13} className="text-accent" />
      Highlight
    </button>
  );
}
