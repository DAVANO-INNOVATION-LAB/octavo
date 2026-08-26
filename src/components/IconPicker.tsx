"use client";

import * as Lucide from "lucide-react";
import { useState } from "react";
import { ICON_GROUPS, type IconName } from "@/lib/icons";

/**
 * Choose a mark for a space or a page. A hidden input carries the value so
 * this drops into an ordinary form and posts with everything else.
 */
export function IconPicker({
  name,
  initial,
  label = "Icon",
}: {
  name: string;
  initial: string;
  label?: string;
}) {
  const [chosen, setChosen] = useState(initial);

  const Glyph = (n: IconName) =>
    (Lucide as unknown as Record<string, React.ComponentType<{ size?: number }>>)[n];

  return (
    <div>
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
        {label}
      </span>
      <input type="hidden" name={name} value={chosen} />
      <div className="max-h-44 overflow-y-auto rounded-lg border border-line bg-bg p-2">
        <button
          type="button"
          onClick={() => setChosen("")}
          className={`mb-2 h-7 rounded-md border px-2.5 text-[11px] transition-colors ${
            chosen === ""
              ? "border-accent bg-accent-soft text-accent"
              : "border-line text-muted hover:text-ink"
          }`}
        >
          Use the initial
        </button>
        {ICON_GROUPS.map((g) => (
          <div key={g.label} className="mb-2 last:mb-0">
            <p className="mb-1 text-[10px] uppercase tracking-[0.1em] text-faint">
              {g.label}
            </p>
            <div className="flex flex-wrap gap-1">
              {g.icons.map((n) => {
                const G = Glyph(n);
                if (!G) return null;
                return (
                  <button
                    key={n}
                    type="button"
                    title={n}
                    onClick={() => setChosen(n)}
                    className={`flex h-8 w-8 items-center justify-center rounded-md border transition-colors ${
                      chosen === n
                        ? "border-accent bg-accent-soft text-accent"
                        : "border-transparent text-muted hover:border-line hover:text-ink"
                    }`}
                  >
                    <G size={16} />
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
