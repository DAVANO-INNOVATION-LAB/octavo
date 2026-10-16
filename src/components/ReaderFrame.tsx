"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Heading } from "@/lib/blocks";

export function ReaderFrame({ title, slideCount = 0, children }: {
  title: string; headings: Heading[]; slideCount?: number; children: ReactNode;
}) {
  const [wide, setWide] = useState(true);
  const [focus, setFocus] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [section, setSection] = useState(0);
  const frame = useRef<HTMLDivElement>(null);
  const presentButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!presenting) return;
    function onKey(event: KeyboardEvent) {
      if ((event.target as HTMLElement).closest("input, textarea, select, [contenteditable=true]")) return;
      if (["ArrowRight", "PageDown", "ArrowLeft", "PageUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        setSection(current => event.key === "Home" ? 0 : event.key === "End" ? Math.max(0, slideCount - 1) : Math.max(0, Math.min(slideCount - 1, current + (["ArrowRight", "PageDown"].includes(event.key) ? 1 : -1))));
      }
      if (event.key === "Escape") {
        setPresenting(false);
        presentButton.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presenting, slideCount]);

  function goTo(index: number) {
    setSection(index);
    frame.current?.scrollIntoView({ behavior: "instant", block: "start" });
  }

  return (
    <div ref={frame} className="reader-frame" data-reading-width={wide ? "wide" : "page"}
      data-focus={focus || presenting} data-presenting={presenting}>
      <div className="reader-toolbar print:hidden" role="toolbar" aria-label="Reading and presentation controls">
        <span className="reader-toolbar-title" title={title}>{presenting ? title : "Reading view"}</span>
        {!presenting && <>
          <button type="button" aria-pressed={wide} onClick={() => setWide(!wide)}>{wide ? "Wide page" : "Book width"}</button>
          <button type="button" aria-pressed={focus} onClick={() => setFocus(!focus)}>{focus ? "Show navigation" : "Focus"}</button>
        </>}
        {presenting && slideCount > 0 && <>
          <button type="button" disabled={section === 0} onClick={() => goTo(section - 1)}>Previous</button>
          <span aria-live="polite" className="text-xs text-muted">{`${section + 1} / ${slideCount}`}</span>
          <button type="button" disabled={section >= slideCount - 1} onClick={() => goTo(section + 1)}>Next slide</button>
        </>}
        <button ref={presentButton} disabled={slideCount === 0} type="button" aria-pressed={presenting} onClick={() => {
          setPresenting(!presenting);
          if (!presenting) goTo(0);
        }}>{presenting ? "Exit presentation" : "Present"}</button>
      </div>
      {presenting && <style>{`@media screen { .reader-frame[data-presenting="true"] .document-slide:not([data-slide-index="${section}"]) { display: none; } }`}</style>}
      {children}
    </div>
  );
}
