"use client";

import { useEffect, useRef } from "react";
import { useOctavoTheme } from "@/lib/theme-store";

const EMBED_ORIGIN = "https://embed.diagrams.net";
const STORE_KEY = "octavo-drawio";

/**
 * The free diagrams.net (draw.io) editor, embedded via its JSON postMessage
 * protocol. Diagrams autosave to this browser; use the editor's own
 * File > Export to save PNG/SVG/XML.
 */
export default function DrawioBoard() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const theme = useOctavoTheme();

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== EMBED_ORIGIN) return;
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
          EMBED_ORIGIN
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

  const src = `${EMBED_ORIGIN}/?embed=1&proto=json&spin=1&libraries=1&noSaveBtn=1&saveAndExit=0&noExitBtn=1&ui=${
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
