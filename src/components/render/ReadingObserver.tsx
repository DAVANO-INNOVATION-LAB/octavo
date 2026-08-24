"use client";

import { useEffect } from "react";

/**
 * Watches the page the way a person over your shoulder would: which passage
 * was on screen, for how long, and whether you scrolled back to it.
 *
 * It is deliberately passive. The literature on documentation feedback is
 * blunt — a "was this helpful?" button gets a 2–4% response, because it asks
 * the reader to pass judgement on a whole page, which is work. Nobody is
 * asked anything here. Re-reading a paragraph three times is a stronger
 * statement about that paragraph than any thumb, and it costs the reader
 * nothing to make.
 *
 * What leaves the browser is a list of block ids with millisecond counts,
 * once, at the end. No identifier is attached and none is derived. It honours
 * Global Privacy Control, because a reader who has asked not to be measured
 * has asked, and a signal taken from people who declined is worth nothing
 * anyway.
 *
 * Time only accrues while the tab is actually in front. A page opened in a
 * background tab and read twenty minutes later is measured from the moment it
 * is looked at — not from the moment it loaded, and not never.
 */
export function ReadingObserver({ pageId }: { pageId: string }) {
  useEffect(() => {
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
    if (nav.globalPrivacyControl || nav.doNotTrack === "1") return;
    if (typeof IntersectionObserver === "undefined") return;

    type Track = { dwell: number; revisits: number; since: number | null };
    let seen = new Map<string, Track>();
    /** Passages currently at least half on screen. */
    const onScreen = new Set<string>();
    /** The passage holding the middle of the screen — where they stopped. */
    let focus: string | null = null;
    let counting = document.visibilityState === "visible";

    const track = (id: string): Track => {
      let t = seen.get(id);
      if (!t) {
        t = { dwell: 0, revisits: 0, since: null };
        seen.set(id, t);
      }
      return t;
    };

    const startClock = (id: string, at: number) => {
      const t = track(id);
      if (t.since !== null) return;
      // Coming back to a passage already read is the signal worth having.
      if (t.dwell > 0) t.revisits++;
      t.since = at;
    };

    const stopClock = (id: string, at: number) => {
      const t = seen.get(id);
      if (!t || t.since === null) return;
      t.dwell += Math.max(0, at - t.since);
      t.since = null;
    };

    /**
     * "On screen" has to mean something for a passage taller than the window
     * as well as one shorter than it. A plain 0.5 threshold silently ignores
     * every long passage, because a block taller than the viewport can never
     * be half visible — and long passages are exactly the ones worth
     * measuring. So compare what is showing against whichever is smaller:
     * the block, or the screen.
     */
    const isOnScreen = (r: IntersectionObserverEntry): boolean => {
      const reference = Math.min(r.boundingClientRect.height, window.innerHeight);
      return reference > 0 && r.intersectionRect.height >= reference * 0.5;
    };

    const io = new IntersectionObserver(
      (records) => {
        const at = performance.now();
        for (const r of records) {
          const id = (r.target as HTMLElement).dataset.blk;
          if (!id) continue;
          if (isOnScreen(r)) {
            onScreen.add(id);
            if (counting) startClock(id, at);
          } else {
            onScreen.delete(id);
            stopClock(id, at);
          }
        }
        const mid = window.innerHeight / 2;
        let best: { id: string; d: number } | null = null;
        for (const el of document.querySelectorAll<HTMLElement>("[data-blk]")) {
          const box = el.getBoundingClientRect();
          if (box.bottom < 0 || box.top > window.innerHeight) continue;
          const d = Math.abs((box.top + box.bottom) / 2 - mid);
          if (!best || d < best.d) best = { id: el.dataset.blk!, d };
        }
        if (best) focus = best.id;
      },
      // Enough steps that isOnScreen is re-evaluated as a tall block scrolls
      // through, rather than only at one crossing point.
      { threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] }
    );

    for (const el of document.querySelectorAll("[data-blk]")) io.observe(el);

    /** Hand over what has accrued and start fresh, so a reader who leaves and
     *  comes back is not counted twice for the same seconds. */
    const flush = () => {
      const at = performance.now();
      for (const id of seen.keys()) stopClock(id, at);

      const blocks = [...seen.entries()]
        .filter(([, t]) => t.dwell > 0 || t.revisits > 0)
        .map(([id, t]) => ({
          id,
          dwell: Math.round(t.dwell),
          revisits: t.revisits,
          exit: id === focus,
        }));
      seen = new Map();
      if (blocks.length === 0) return;

      const body = JSON.stringify({ pageId, blocks });
      // sendBeacon survives the page going away; a plain fetch does not.
      if (navigator.sendBeacon) {
        navigator.sendBeacon(
          "/api/reading",
          new Blob([body], { type: "application/json" })
        );
      } else {
        fetch("/api/reading", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    };

    const onVisibility = () => {
      const at = performance.now();
      if (document.visibilityState === "hidden") {
        counting = false;
        flush();
      } else {
        counting = true;
        // Resume on whatever is in front of them now.
        for (const id of onScreen) startClock(id, at);
      }
    };

    // pagehide fires where unload does not, notably on iOS.
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
      io.disconnect();
      flush();
    };
  }, [pageId]);

  return null;
}
