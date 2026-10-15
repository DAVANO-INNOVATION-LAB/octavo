"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Heading } from "@/lib/blocks";

export function ReaderFrame({ title, headings, children }: {
  title: string; headings: Heading[]; children: ReactNode;
}) {
  const [wide, setWide] = useState(true);
  const [focus, setFocus] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [section, setSection] = useState(-1);
  const frame = useRef<HTMLDivElement>(null);
  const presentButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!presenting) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setPresenting(false);
        presentButton.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presenting]);

  function goTo(index: number) {
    setSection(index);
    const target = index < 0 ? frame.current : document.getElementById(headings[index].id);
    target?.scrollIntoView({ behavior: "instant", block: "start" });
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
        {presenting && headings.length > 0 && <>
          <button type="button" disabled={section < 0} onClick={() => goTo(section - 1)}>Previous</button>
          <span aria-live="polite" className="text-xs text-muted">{section < 0 ? "Overview" : `${section + 1} / ${headings.length}`}</span>
          <button type="button" disabled={section >= headings.length - 1} onClick={() => goTo(section + 1)}>Next section</button>
        </>}
        <button ref={presentButton} type="button" aria-pressed={presenting} onClick={() => {
          setPresenting(!presenting);
          if (!presenting) goTo(-1);
        }}>{presenting ? "Exit presentation" : "Present"}</button>
      </div>
      {children}
    </div>
  );
}
