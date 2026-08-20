"use client";

import { useSyncExternalStore } from "react";

// Client-side theme/palette state, exposed as external stores so components
// subscribe instead of copying into effect-initialized state.

function subscribeTheme(cb: () => void) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  window.addEventListener("octavo-theme", cb);
  mq.addEventListener("change", cb);
  return () => {
    window.removeEventListener("octavo-theme", cb);
    mq.removeEventListener("change", cb);
  };
}

function themeSnapshot(): "light" | "dark" {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark" || attr === "light") return attr;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** The active light/dark mode, live-updating on toggle and OS change. */
export function useOctavoTheme(): "light" | "dark" {
  return useSyncExternalStore(subscribeTheme, themeSnapshot, () => "light");
}

export function setOctavoTheme(next: "light" | "dark") {
  localStorage.setItem("octavo-theme", next);
  document.documentElement.setAttribute("data-theme", next);
  window.dispatchEvent(new CustomEvent("octavo-theme", { detail: next }));
}

function subscribePrefs(cb: () => void) {
  window.addEventListener("octavo-prefs", cb);
  return () => window.removeEventListener("octavo-prefs", cb);
}

/** Saved palette preset id ("default" when unset). */
export function usePalettePref(): string {
  return useSyncExternalStore(
    subscribePrefs,
    () => localStorage.getItem("octavo-palette") ?? "default",
    () => "default"
  );
}

/** Whether the user has switched the seasonal dress off. */
export function useSeasonalOff(): boolean {
  return useSyncExternalStore(
    subscribePrefs,
    () => localStorage.getItem("octavo-seasonal") === "off",
    () => false
  );
}

export function setPrefs(prefs: { palette?: string; seasonalOff?: boolean }) {
  if (prefs.palette !== undefined)
    localStorage.setItem("octavo-palette", prefs.palette);
  if (prefs.seasonalOff !== undefined)
    localStorage.setItem("octavo-seasonal", prefs.seasonalOff ? "off" : "on");
  window.dispatchEvent(new CustomEvent("octavo-prefs"));
}
