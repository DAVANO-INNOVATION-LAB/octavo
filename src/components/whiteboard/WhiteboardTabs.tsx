"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/whiteboard", label: "Sketch", hint: "Freehand — Excalidraw" },
  { href: "/whiteboard/drawio", label: "Diagram", hint: "Precise — draw.io" },
];

export function WhiteboardTabs() {
  const pathname = usePathname();
  return (
    <div className="flex items-center gap-1 border-b border-line bg-bg px-4 py-2 sm:px-6">
      {TABS.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`flex h-8 items-center gap-2 rounded-md px-3 text-sm transition-colors ${
              active
                ? "bg-accent-soft font-medium text-accent"
                : "text-muted hover:bg-surface-2 hover:text-ink"
            }`}
          >
            {t.label}
            <span className="hidden text-[11px] text-faint sm:inline">
              {t.hint}
            </span>
          </Link>
        );
      })}
      <span className="ml-auto hidden text-[11px] text-faint md:inline">
        Saved in this browser — export from the editor to keep or share
      </span>
    </div>
  );
}
