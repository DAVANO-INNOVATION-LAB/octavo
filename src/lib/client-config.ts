"use client";

import { DRAWIO_PATH, type PublicConfig } from "./config-shared";

declare global {
  interface Window {
    __OCTAVO__?: PublicConfig;
    EXCALIDRAW_ASSET_PATH?: string;
  }
}

const FALLBACK: PublicConfig = {
  drawioOrigin: DRAWIO_PATH,
  offline: false,
  collab: true,
};

/**
 * Runtime configuration injected by the server in the document head. The
 * fallback covers rendering before hydration; the values are read at call
 * time so they reflect whatever the running container was given.
 */
/**
 * Where to load the draw.io editor from. Normally a path on this instance;
 * an operator may override it with their own deployment.
 */
export function drawioSrc(query: string): string {
  const base = clientConfig().drawioOrigin;
  // Served from our own public directory, the editor has to be named by file:
  // a bare directory redirects to the path without its trailing slash and
  // then resolves to nothing. A remote origin serves its own index.
  return base.startsWith("/")
    ? `${base}/index.html?${query}`
    : `${base}/?${query}`;
}

/**
 * The origin every message from the embedded editor is checked against.
 * When draw.io is served from this instance the frame's origin is ours, so
 * comparing against the configured path would reject every message.
 */
export function drawioOriginForMessages(): string {
  const base = clientConfig().drawioOrigin;
  if (base.startsWith("/")) {
    return typeof window === "undefined" ? "" : window.location.origin;
  }
  return base;
}

export function collabEnabled(): boolean {
  return clientConfig().collab !== false;
}

export function clientConfig(): PublicConfig {
  if (typeof window === "undefined") return FALLBACK;
  return window.__OCTAVO__ ?? FALLBACK;
}
