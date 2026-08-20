"use client";

import { useMemo, useRef } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import { useOctavoTheme } from "@/lib/theme-store";
import "@excalidraw/excalidraw/index.css";

const STORE_KEY = "octavo-whiteboard";

export default function Board() {
  const theme = useOctavoTheme();
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const initialData = useMemo(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return { elements: data.elements ?? [], appState: { theme } };
    } catch {
      return null;
    }
  }, [theme]);

  return (
    <div className="h-[calc(100vh-9.6rem)] w-full">
      <Excalidraw
        theme={theme}
        initialData={initialData}
        onChange={(elements) => {
          if (saveTimer.current) clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(() => {
            try {
              localStorage.setItem(
                STORE_KEY,
                JSON.stringify({ elements: elements.filter((e) => !e.isDeleted) })
              );
            } catch {
              /* storage full — sketch stays in memory */
            }
          }, 500);
        }}
        UIOptions={{
          canvasActions: {
            toggleTheme: false,
          },
        }}
      />
    </div>
  );
}
