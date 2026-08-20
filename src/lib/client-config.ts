"use client";

import { DEFAULT_DRAWIO_ORIGIN, type PublicConfig } from "./config-shared";

declare global {
  interface Window {
    __OCTAVO__?: PublicConfig;
    EXCALIDRAW_ASSET_PATH?: string;
  }
}

const FALLBACK: PublicConfig = {
  drawioOrigin: DEFAULT_DRAWIO_ORIGIN,
  drawioEnabled: true,
  offline: false,
  collab: true,
};

/**
 * Runtime configuration injected by the server in the document head. The
 * fallback covers rendering before hydration; the values are read at call
 * time so they reflect whatever the running container was given.
 */
export function collabEnabled(): boolean {
  return clientConfig().collab !== false;
}

export function clientConfig(): PublicConfig {
  if (typeof window === "undefined") return FALLBACK;
  return window.__OCTAVO__ ?? FALLBACK;
}
