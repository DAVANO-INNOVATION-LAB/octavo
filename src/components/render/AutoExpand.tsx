"use client";

import { useEffect } from "react";

/**
 * A link into a collapsed section must land somewhere visible.
 *
 * Anchors, comment-thread links and reading-report links all address blocks
 * by id. When the target sits inside a closed <details>, the browser scrolls
 * to a point the reader cannot see — so any link into the page opens every
 * section on the way down to its target first.
 */
export function AutoExpand() {
  useEffect(() => {
    const reveal = () => {
      const hash = decodeURIComponent(window.location.hash.slice(1));
      if (!hash) return;
      const target =
        document.getElementById(hash) ??
        document.querySelector(
          `[data-blk="${CSS.escape(hash.replace(/^blk-/, ""))}"]`
        );
      if (!target) return;
      let node = target.parentElement;
      let opened = false;
      while (node) {
        if (node instanceof HTMLDetailsElement && !node.open) {
          node.open = true;
          opened = true;
        }
        node = node.parentElement;
      }
      // The first scroll happened while the section was closed; do it again
      // now that the target actually has a position.
      if (opened) target.scrollIntoView({ block: "start" });
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, []);
  return null;
}
