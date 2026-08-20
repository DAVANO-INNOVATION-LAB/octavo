import "server-only";
import { DEFAULT_DRAWIO_ORIGIN, type PublicConfig } from "./config-shared";

/**
 * Configuration that reaches the browser, resolved when the server renders
 * rather than when the image is built.
 *
 * NEXT_PUBLIC_* is inlined at build time, which is no use to an operator who
 * pulls a published image and cannot rebuild it. These values are read from
 * the environment on every render and injected into the document instead, so
 * `docker run -e ...` is enough to change them.
 */

/**
 * Origin of the draw.io editor to embed. Air-gapped deployments run their own
 * (`jgraph/drawio`) and set OCTAVO_DRAWIO_URL to it.
 *
 * Only the origin is kept: the value is compared against `event.origin` on
 * every postMessage from the embedded editor, and an origin is what that
 * check can be trusted against. A malformed value falls back to the default
 * rather than disabling the check.
 */
export function drawioOrigin(): string {
  const raw = process.env.OCTAVO_DRAWIO_URL?.trim();
  if (!raw) return DEFAULT_DRAWIO_ORIGIN;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return DEFAULT_DRAWIO_ORIGIN;
    }
    return url.origin;
  } catch {
    return DEFAULT_DRAWIO_ORIGIN;
  }
}

/**
 * True when the operator has declared this instance offline. It stops the two
 * features that would otherwise reach the public internet — the hosted draw.io
 * editor and third-party video embeds — so they fail visibly at the point of
 * use instead of hanging on a request that cannot complete.
 */
export function isOffline(): boolean {
  const v = process.env.OCTAVO_OFFLINE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function publicConfig(): PublicConfig {
  const offline = isOffline();
  const origin = drawioOrigin();
  // Offline with no self-hosted editor configured means no editor at all.
  const drawioEnabled = !offline || origin !== DEFAULT_DRAWIO_ORIGIN;
  return { drawioOrigin: origin, drawioEnabled, offline };
}

/**
 * The script that publishes the config to the browser, plus the Excalidraw
 * asset path that keeps its fonts local. JSON.stringify is the escaping here;
 * every value originates from the operator's environment, never from a user.
 */
export function bootstrapScript(): string {
  const cfg = publicConfig();
  return `window.__OCTAVO__=${JSON.stringify(cfg)};window.EXCALIDRAW_ASSET_PATH="/excalidraw-assets/";`;
}
