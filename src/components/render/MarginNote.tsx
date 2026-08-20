"use client";

import { useState } from "react";
import type { ReactNode } from "react";

/**
 * An inline annotation. On a wide screen it opens into the margin beside the
 * text, the way a printed book takes a footnote; on a narrow one it opens
 * beneath the line. Markdown footnotes import as these.
 */
export function MarginNote({
  note,
  children,
}: {
  note: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="margin-note">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`margin-note-anchor${open ? " is-open" : ""}`}
      >
        {children}
      </button>
      {open && <span className="margin-note-body">{note}</span>}
    </span>
  );
}
