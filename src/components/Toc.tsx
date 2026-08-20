"use client";

import { useEffect, useState } from "react";
import type { Heading } from "@/lib/blocks";

/** "On this page" rail with scroll-spy. */
export function Toc({ headings }: { headings: Heading[] }) {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    if (!headings.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setActive(e.target.id);
            break;
          }
        }
      },
      { rootMargin: "-80px 0px -70% 0px", threshold: 0 }
    );
    for (const h of headings) {
      const el = document.getElementById(h.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [headings]);

  if (!headings.length) return null;

  return (
    <div>
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">
        On this page
      </p>
      <ul className="space-y-1 border-l border-line">
        {headings.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              className={`-ml-px block border-l-2 py-0.5 pr-2 text-[13px] leading-snug transition-colors ${
                h.level >= 3 ? "pl-6" : "pl-3.5"
              } ${
                active === h.id
                  ? "border-accent font-medium text-accent"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
