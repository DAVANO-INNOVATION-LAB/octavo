"use client";

import { useEffect, useRef } from "react";
import { useOctavoTheme } from "@/lib/theme-store";
import { clientConfig } from "@/lib/client-config";

// Resolved per render from the config the server injected, so an operator
// can point this at a self-hosted draw.io without rebuilding the image.
const embedOrigin = () => clientConfig().drawioOrigin;
const STORE_KEY = "octavo-drawio";

/**
 * The free diagrams.net (draw.io) editor, embedded via its JSON postMessage
 * protocol. Diagrams autosave to this browser; use the editor's own
 * File > Export to save PNG/SVG/XML.
 */
export default function DrawioBoard() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const theme = useOctavoTheme();
  const { drawioEnabled } = clientConfig();

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== embedOrigin()) return;
      if (e.source !== frameRef.current?.contentWindow) return;
      let msg: { event?: string; xml?: string };
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      const frame = frameRef.current;
      if (!frame?.contentWindow) return;
      if (msg.event === "init") {
        const xml = localStorage.getItem(STORE_KEY) ?? "";
        frame.contentWindow.postMessage(
          JSON.stringify({ action: "load", autosave: 1, xml }),
          embedOrigin()
        );
      } else if (msg.event === "autosave" || msg.event === "save") {
        if (typeof msg.xml === "string") {
          try {
            localStorage.setItem(STORE_KEY, msg.xml);
          } catch {
            /* storage full — diagram stays in the editor */
          }
        }
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Offline with no self-hosted editor configured: say so plainly instead of
  // mounting a frame that can only spin. Excalidraw, next door, still works.
  if (!drawioEnabled) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md text-center">
          <p className="text-sm font-medium text-ink">
            The draw.io editor is not available offline
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            This instance runs disconnected, and the draw.io editor is hosted
            elsewhere. Run your own alongside Octavo and set{" "}
            <code className="rounded bg-wash px-1 font-mono text-xs">
              OCTAVO_DRAWIO_URL
            </code>{" "}
            to its address to turn this back on.
          </p>
          <p className="mt-3 text-sm text-muted">
            The freehand whiteboard needs no network and is ready now.
          </p>
        </div>
      </div>
    );
  }

  const src = `${embedOrigin()}/?embed=1&proto=json&spin=1&libraries=1&noSaveBtn=1&saveAndExit=0&noExitBtn=1&ui=${
    theme === "dark" ? "dark" : "min"
  }`;

  return (
    <iframe
      key={theme}
      ref={frameRef}
      src={src}
      title="draw.io diagram editor"
      className="h-full w-full border-0"
    />
  );
}
