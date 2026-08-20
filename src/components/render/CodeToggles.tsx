"use client";

import { useState } from "react";
import { Hash, WrapText } from "lucide-react";

/** Per-block reader controls: the gutter and line wrapping. */
export function CodeToggles() {
  const [numbers, setNumbers] = useState<boolean | null>(null);
  const [wrap, setWrap] = useState<boolean | null>(null);

  const flip = (
    e: React.MouseEvent<HTMLButtonElement>,
    cls: string,
    set: (v: boolean) => void
  ) => {
    const fig = e.currentTarget.closest("figure");
    if (!fig) return;
    const on = fig.classList.toggle(cls);
    set(on);
  };

  const btn = "flex h-6 w-6 items-center justify-center rounded text-[#8a8375] transition-colors hover:bg-white/10 hover:text-white";
  const active = "bg-white/10 text-white";

  return (
    <>
      <button
        title="Line numbers"
        aria-label="Toggle line numbers"
        onClick={(e) => flip(e, "codeblock-numbered", setNumbers)}
        className={`${btn} ${numbers ? active : ""}`}
      >
        <Hash size={13} />
      </button>
      <button
        title="Wrap long lines"
        aria-label="Toggle line wrapping"
        onClick={(e) => flip(e, "codeblock-wrap", setWrap)}
        className={`${btn} ${wrap ? active : ""}`}
      >
        <WrapText size={13} />
      </button>
    </>
  );
}
