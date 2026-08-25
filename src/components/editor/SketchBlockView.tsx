"use client";

import { lazy, Suspense, useState } from "react";
import { PenLine, Shapes } from "lucide-react";
import { useOctavoTheme } from "@/lib/theme-store";

/**
 * A hand sketch that lives inside the page.
 *
 * The whiteboard at /whiteboard is a scratchpad — one shared canvas, saved
 * in the browser. This is the other thing people kept asking it to be: a
 * drawing that belongs to a document, saved with the document, versioned
 * with the document, and rendered to readers as a plain image with no
 * canvas mounted at all.
 *
 * Excalidraw is heavy, so it loads only at the moment of editing — a page
 * full of sketches costs readers nothing but images. The scene JSON rides in
 * the block props next to the rendered SVG, the same arrangement the draw.io
 * block uses, so editing reopens exactly what was drawn.
 */

const Excalidraw = lazy(() =>
  import("@excalidraw/excalidraw").then((m) => ({ default: m.Excalidraw }))
);

type ExcalidrawAPI = {
  getSceneElements: () => readonly unknown[];
  getAppState: () => Record<string, unknown>;
  getFiles: () => Record<string, unknown>;
};

export function SketchBlockView({
  scene,
  svg,
  onSave,
}: {
  scene: string;
  svg: string;
  onSave: (scene: string, svg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [api, setApi] = useState<ExcalidrawAPI | null>(null);
  const [saving, setSaving] = useState(false);
  const theme = useOctavoTheme();

  const initialData = (() => {
    try {
      const parsed = JSON.parse(scene);
      return { elements: parsed.elements ?? [], appState: { theme } };
    } catch {
      return { elements: [], appState: { theme } };
    }
  })();

  async function save() {
    if (!api) return;
    setSaving(true);
    try {
      const elements = api.getSceneElements().filter(
        (e) => !(e as { isDeleted?: boolean }).isDeleted
      );
      const { exportToSvg } = await import("@excalidraw/excalidraw");
      const node = await exportToSvg({
        elements: elements as never,
        appState: {
          ...api.getAppState(),
          exportBackground: false,
          // Export neutral; the reader page tints via CSS for dark mode.
          theme: "light",
        } as never,
        files: api.getFiles() as never,
      });
      node.removeAttribute("width");
      node.removeAttribute("height");
      const svgText = new XMLSerializer().serializeToString(node);
      onSave(
        JSON.stringify({ elements }),
        `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgText)))}`
      );
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-bg">
        <div className="flex h-12 items-center justify-between border-b border-line px-4">
          <span className="text-sm font-medium text-ink">Sketch</span>
          <span className="flex items-center gap-2">
            <button
              onClick={() => setEditing(false)}
              className="h-8 rounded-md border border-line px-3 text-xs text-muted hover:text-ink"
            >
              Discard
            </button>
            <button
              onClick={() => void save()}
              disabled={saving}
              className="h-8 rounded-md bg-accent px-3 text-xs font-medium text-accent-ink disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save to page"}
            </button>
          </span>
        </div>
        <div className="min-h-0 flex-1">
          <Suspense
            fallback={
              <p className="flex h-full items-center justify-center text-sm text-faint">
                Loading the canvas…
              </p>
            }
          >
            <Excalidraw
              theme={theme}
              initialData={initialData}
              excalidrawAPI={(a) => setApi(a as unknown as ExcalidrawAPI)}
              UIOptions={{ canvasActions: { toggleTheme: false } }}
            />
          </Suspense>
        </div>
      </div>
    );
  }

  if (!svg) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line px-4 py-8 text-sm text-faint transition-colors hover:border-line-strong hover:text-ink"
      >
        <Shapes size={16} />
        Draw a sketch
      </button>
    );
  }

  return (
    <figure className="group/sketch relative">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={svg} alt="Sketch" className="mx-auto max-h-[480px] w-auto max-w-full" />
      <button
        onClick={() => setEditing(true)}
        className="absolute right-2 top-2 flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-muted opacity-0 shadow-card transition-opacity hover:text-ink group-hover/sketch:opacity-100"
      >
        <PenLine size={13} />
        Edit sketch
      </button>
    </figure>
  );
}
