"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Moon, Palette, Sun } from "lucide-react";
import {
  setOctavoTheme,
  setPrefs,
  useOctavoTheme,
  usePalettePref,
  useSeasonalOff,
} from "@/lib/theme-store";

const PRESETS = [
  { id: "default", name: "Paper & Ink", swatch: "#b8401b", note: "The Octavo default" },
  { id: "slate", name: "Slate", swatch: "#2b73c9", note: "Cool blue on black" },
  { id: "forest", name: "Forest", swatch: "#3c7a3d", note: "Moss and pine" },
  { id: "indigo", name: "Indigo", swatch: "#5a4bd1", note: "Deep violet" },
  { id: "rosewood", name: "Rosewood", swatch: "#a52e4e", note: "Burgundy warmth" },
  { id: "graphite", name: "Graphite", swatch: "#6b6b6b", note: "Pure monochrome" },
];

const SEASONS: Record<number, { id: string; name: string }> = {
  9: { id: "hallows", name: "Hallows" },
  10: { id: "harvest", name: "Harvest" },
  11: { id: "yuletide", name: "Yuletide" },
  0: { id: "meridian", name: "Meridian" },
};

function applyPalette(palette: string, seasonalOff: boolean) {
  const season = SEASONS[new Date().getMonth()];
  const active = season && !seasonalOff ? season.id : palette;
  if (active === "default" || !active)
    document.documentElement.removeAttribute("data-palette");
  else document.documentElement.setAttribute("data-palette", active);
}

export function ThemeMenu() {
  const [open, setOpen] = useState(false);
  const dark = useOctavoTheme() === "dark";
  const palette = usePalettePref();
  const seasonalOff = useSeasonalOff();
  const ref = useRef<HTMLDivElement>(null);
  const season = SEASONS[new Date().getMonth()];

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function toggleDark() {
    setOctavoTheme(dark ? "light" : "dark");
  }

  function choosePalette(id: string) {
    setPrefs({ palette: id });
    applyPalette(id, seasonalOff);
  }

  function toggleSeasonal() {
    const next = !seasonalOff;
    setPrefs({ seasonalOff: next });
    applyPalette(palette, next);
  }

  const seasonActive = Boolean(season) && !seasonalOff;

  return (
    <div ref={ref} className="relative">
      <div className="flex items-center">
        <button
          onClick={toggleDark}
          aria-label="Toggle light or dark"
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          {dark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button
          onClick={() => setOpen((o) => !o)}
          aria-label="Theme presets"
          className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-surface-2 hover:text-ink ${
            open ? "bg-surface-2 text-ink" : "text-muted"
          }`}
        >
          <Palette size={16} />
        </button>
      </div>

      {open && (
        <div className="rise absolute right-0 top-10 z-50 w-64 rounded-xl border border-line bg-surface p-2 shadow-pop">
          <p className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">
            Theme
          </p>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => choosePalette(p.id)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-surface-2 ${
                palette === p.id && !seasonActive ? "bg-accent-soft" : ""
              }`}
            >
              <span
                className="h-4 w-4 shrink-0 rounded-full border border-black/10"
                style={{ background: p.swatch }}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-ink">{p.name}</span>
                <span className="block text-[11px] text-faint">{p.note}</span>
              </span>
              {palette === p.id && (
                <Check size={14} className="shrink-0 text-accent" />
              )}
            </button>
          ))}

          {season && (
            <div className="mt-1 border-t border-line pt-1">
              <button
                onClick={toggleSeasonal}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-surface-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-ink">
                    {season.name}
                  </span>
                  <span className="block text-[11px] leading-snug text-faint">
                    {seasonalOff
                      ? "The seasonal dress is put away"
                      : "Dressing the library this month"}
                  </span>
                </span>
                <span
                  className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                    seasonalOff
                      ? "border border-line-strong bg-surface-2"
                      : "bg-accent"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-4 w-4 rounded-full bg-surface shadow-sm transition-all ${
                      seasonalOff ? "left-0.5" : "left-[18px]"
                    }`}
                  />
                </span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
