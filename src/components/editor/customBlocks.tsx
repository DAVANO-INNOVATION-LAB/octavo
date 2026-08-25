"use client";

import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultStyleSpecs,
  insertOrUpdateBlockForSlashMenu,
} from "@blocknote/core";
import {
  createReactBlockSpec,
  createReactStyleSpec,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import katex from "katex";
import { Model3D, type ModelKind } from "@/components/render/Model3D";
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Info,
  Boxes,
  Image as ImageIcon,
  ListOrdered,
  OctagonAlert,
  PenTool,
  Sigma,
  Shapes, FileInput, SlidersHorizontal,
} from "lucide-react";
import { SketchBlockView } from "./SketchBlockView";
import { SyncedPagePicker } from "./SyncedPagePicker";
import { drawioOriginForMessages, drawioSrc } from "@/lib/client-config";

// Resolved per render from the config the server injected, so an operator
// can point this at a self-hosted draw.io without rebuilding the image.
const drawioOrigin = () => drawioOriginForMessages();

/**
 * A draw.io diagram that lives in the page — Confluence-style. The diagram
 * XML is stored in the block; the rendered SVG is uploaded to the space's
 * file store, so published pages show a plain image with no external calls.
 */
function DrawioEditorModal({
  xml,
  onSave,
  onClose,
}: {
  xml: string;
  onSave: (xml: string, src: string) => void;
  onClose: () => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const pendingXml = useRef<string>(xml);
  const [status, setStatus] = useState("Loading the drafting table…");

  useEffect(() => {
    async function onMessage(e: MessageEvent) {
      if (e.origin !== drawioOrigin()) return;
      if (e.source !== frameRef.current?.contentWindow) return;
      let msg: { event?: string; xml?: string; data?: string };
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      const frame = frameRef.current;
      if (!frame?.contentWindow) return;
      if (msg.event === "init") {
        frame.contentWindow.postMessage(
          JSON.stringify({ action: "load", xml: pendingXml.current }),
          drawioOrigin()
        );
        setStatus("");
      } else if (msg.event === "save") {
        pendingXml.current = msg.xml ?? pendingXml.current;
        setStatus("Rendering…");
        frame.contentWindow.postMessage(
          JSON.stringify({ action: "export", format: "xmlsvg" }),
          drawioOrigin()
        );
      } else if (msg.event === "export" && typeof msg.data === "string") {
        try {
          const blob = await (await fetch(msg.data)).blob();
          const body = new FormData();
          body.append(
            "file",
            new File([blob], "diagram.svg", { type: "image/svg+xml" })
          );
          const res = await fetch("/api/upload", { method: "POST", body });
          if (!res.ok) throw new Error("upload failed");
          const data = await res.json();
          onSave(pendingXml.current, data.url as string);
        } catch {
          setStatus("Saving failed — the diagram is unchanged.");
        }
      } else if (msg.event === "exit") {
        onClose();
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onSave, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/60 p-3 backdrop-blur-sm sm:p-6">
      <div className="relative flex-1 overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
        {status && (
          <p className="absolute inset-x-0 top-1/2 z-10 -translate-y-1/2 text-center text-sm text-faint">
            {status}
          </p>
        )}
        <iframe
          ref={frameRef}
          src={drawioSrc("embed=1&proto=json&spin=1&ui=min&saveAndExit=1&noExitBtn=0")}
          title="Diagram editor"
          className="h-full w-full border-0"
        />
      </div>
    </div>
  );
}

function DrawioBlockView({
  src,
  xml,
  onSave,
}: {
  src: string;
  xml: string;
  onSave: (xml: string, src: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="blk-drawio">
      {src ? (
        <button
          type="button"
          className="blk-drawio-preview"
          title="Edit diagram"
          onClick={() => setEditing(true)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt="Diagram" />
          <span className="blk-drawio-hint">
            <PenTool size={12} /> Edit diagram
          </span>
        </button>
      ) : (
        <button
          type="button"
          className="blk-drawio-empty"
          onClick={() => setEditing(true)}
        >
          <PenTool size={15} />
          Create a draw.io diagram
        </button>
      )}
      {editing && (
        <DrawioEditorModal
          xml={xml}
          onSave={(newXml, newSrc) => {
            setEditing(false);
            onSave(newXml, newSrc);
          }}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

// The docs block library: callouts, expandables, steps, and math —
// the vocabulary that separates product docs from a plain wiki.

export const TONES = ["info", "success", "warning", "danger"] as const;
export type Tone = (typeof TONES)[number];

const TONE_ICON: Record<Tone, React.ReactNode> = {
  info: <Info size={16} />,
  success: <CheckCircle2 size={16} />,
  warning: <AlertTriangle size={16} />,
  danger: <OctagonAlert size={16} />,
};

export const Callout = createReactBlockSpec(
  {
    type: "callout",
    propSchema: {
      tone: { default: "info" as string, values: [...TONES] },
    },
    content: "inline",
  },
  {
    render: (props) => {
      const tone = (props.block.props.tone as Tone) ?? "info";
      return (
        <div className={`blk-callout blk-callout-${tone}`} data-tone={tone}>
          <button
            type="button"
            className="blk-callout-icon"
            title="Change tone"
            onClick={() => {
              const next =
                TONES[(TONES.indexOf(tone) + 1) % TONES.length];
              props.editor.updateBlock(props.block, {
                props: { tone: next },
              });
            }}
          >
            {TONE_ICON[tone]}
          </button>
          <div className="blk-callout-body" ref={props.contentRef} />
        </div>
      );
    },
  }
);

export const Expandable = createReactBlockSpec(
  {
    type: "expandable",
    propSchema: {},
    content: "inline",
  },
  {
    render: (props) => (
      <div className="blk-expandable">
        <div className="blk-expandable-head">
          <ChevronRight size={14} className="blk-expandable-chevron" />
          <div className="blk-expandable-title" ref={props.contentRef} />
        </div>
        <p className="blk-expandable-hint">
          Nested blocks under this one (Tab to indent) collapse behind the
          title on the published page.
        </p>
      </div>
    ),
  }
);

export const Step = createReactBlockSpec(
  {
    type: "step",
    propSchema: {},
    content: "inline",
  },
  {
    render: (props) => {
      // Number by position among consecutive step siblings.
      let n = 1;
      try {
        const doc = props.editor.document as { id: string; type: string }[];
        const idx = doc.findIndex((b) => b.id === props.block.id);
        for (let i = idx - 1; i >= 0 && doc[i]?.type === "step"; i--) n++;
      } catch {
        /* nested or unfindable — leave at 1 */
      }
      return (
        <div className="blk-step">
          <span className="blk-step-n">{n}</span>
          <div className="blk-step-body" ref={props.contentRef} />
        </div>
      );
    },
  }
);

export const MathBlock = createReactBlockSpec(
  {
    type: "math",
    propSchema: {},
    content: "inline",
  },
  {
    render: (props) => {
      const tex = Array.isArray(props.block.content)
        ? props.block.content
            .map((c) => ("text" in c ? (c as { text: string }).text : ""))
            .join("")
        : "";
      let html = "";
      let err = "";
      try {
        html = katex.renderToString(tex || "\\ldots", {
          displayMode: true,
          throwOnError: true,
        });
      } catch (e) {
        err = e instanceof Error ? e.message.replace("KaTeX parse error: ", "") : "parse error";
      }
      return (
        <div className="blk-math">
          <div className="blk-math-src" ref={props.contentRef} />
          {err ? (
            <p className="blk-math-err">{err}</p>
          ) : (
            <div
              className="blk-math-preview"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </div>
      );
    },
  }
);

export const Drawio = createReactBlockSpec(
  {
    type: "drawio",
    propSchema: {
      xml: { default: "" },
      src: { default: "" },
    },
    content: "none",
  },
  {
    render: (props) => (
      <DrawioBlockView
        src={String(props.block.props.src ?? "")}
        xml={String(props.block.props.xml ?? "")}
        onSave={(xml, src) =>
          props.editor.updateBlock(props.block, { props: { xml, src } })
        }
      />
    ),
  }
);

/**
 * A margin note: text carrying an annotation. Stored as a style so the note
 * travels with the words it qualifies rather than sitting in a separate block.
 */
export const NoteStyle = createReactStyleSpec(
  { type: "note", propSchema: "string" },
  {
    render: (props) => (
      <span
        className="blk-note-mark"
        title={props.value}
        ref={props.contentRef}
      />
    ),
  }
);

/** An image with a second source used in dark mode. */
export const ThemeImage = createReactBlockSpec(
  {
    type: "themeImage",
    propSchema: {
      url: { default: "" },
      darkUrl: { default: "" },
      caption: { default: "" },
    },
    content: "none",
  },
  {
    render: (props) => {
      const url = String(props.block.props.url ?? "");
      const darkUrl = String(props.block.props.darkUrl ?? "");
      const caption = String(props.block.props.caption ?? "");
      const set = async (which: "url" | "darkUrl") => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.onchange = async () => {
          const file = input.files?.[0];
          if (!file) return;
          const body = new FormData();
          body.append("file", file);
          const res = await fetch("/api/upload", { method: "POST", body });
          if (!res.ok) return;
          const data = await res.json();
          props.editor.updateBlock(props.block, {
            props: { [which]: data.url as string },
          });
        };
        input.click();
      };
      return (
        <div className="blk-themeimage">
          {[
            ["url", "Light mode", url],
            ["darkUrl", "Dark mode", darkUrl],
          ].map(([key, label, src]) => (
            <button
              key={key}
              type="button"
              className="blk-themeimage-slot"
              onClick={() => set(key as "url" | "darkUrl")}
            >
              {src ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={src} alt={caption || String(label)} />
              ) : (
                <span className="blk-themeimage-empty">
                  <ImageIcon size={14} /> {label}
                </span>
              )}
              <span className="blk-themeimage-label">{label}</span>
            </button>
          ))}
        </div>
      );
    },
  }
);

const MODEL_KINDS = [
  ["architecture", "Architecture"],
  ["network", "Network"],
  ["pipeline", "Pipeline"],
  ["culture", "Cell culture"],
  ["molecule", "Molecule"],
  ["embedding", "Embedding space"],
] as const;

/** A 3D model scene chosen per discipline. */
export const Model3DBlock = createReactBlockSpec(
  {
    type: "model3d",
    propSchema: {
      kind: { default: "architecture" as string },
      title: { default: "" as string },
    },
    content: "none",
  },
  {
    render: (props) => {
      const kind = String(props.block.props.kind ?? "architecture");
      const title = String(props.block.props.title ?? "");
      return (
        <div className="blk-model-edit">
          <div className="blk-model-edit-bar">
            <Boxes size={14} className="shrink-0" />
            <select
              value={kind}
              onChange={(e) =>
                props.editor.updateBlock(props.block, {
                  props: { kind: e.target.value },
                })
              }
            >
              {MODEL_KINDS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <input
              value={title}
              placeholder="Caption (optional)"
              onChange={(e) =>
                props.editor.updateBlock(props.block, {
                  props: { title: e.target.value },
                })
              }
            />
          </div>
          <Model3D kind={kind as ModelKind} height={220} />
        </div>
      );
    },
  }
);

/**
 * An API operation a reader can send. Generated by the OpenAPI import; the
 * editor registers it so a generated page opens like any other, and an author
 * can move or delete it.
 */
export const ApiRequestBlock = createReactBlockSpec(
  {
    type: "apiRequest",
    propSchema: {
      method: { default: "GET" as string },
      path: { default: "/" as string },
      servers: { default: "" as string },
      params: { default: "[]" as string },
      body: { default: "" as string },
      auth: { default: "" as string },
    },
    content: "none",
  },
  {
    render: (props) => {
      const p = props.block.props as Record<string, string>;
      return (
        <div className="blk-api-editor" contentEditable={false}>
          <span className="blk-api-editor-method">{p.method}</span>
          <span className="blk-api-editor-path">{p.path}</span>
          <span className="blk-api-editor-note">
            interactive when published
          </span>
        </div>
      );
    },
  }
);

/**
 * A sketch drawn in place — Excalidraw behind the same contract as the
 * draw.io block: source in one prop, rendered SVG in the other.
 */
export const Sketch = createReactBlockSpec(
  {
    type: "sketch",
    propSchema: {
      scene: { default: "" },
      svg: { default: "" },
    },
    content: "none",
  },
  {
    render: (props) => (
      <SketchBlockView
        scene={String(props.block.props.scene ?? "")}
        svg={String(props.block.props.svg ?? "")}
        onSave={(scene, svg) =>
          props.editor.updateBlock(props.block, { props: { scene, svg } })
        }
      />
    ),
  }
);

/**
 * Another page, embedded here. Write once, reference everywhere: the reader
 * always sees the current content of the source page, resolved at read time
 * on the server. In the editor it is a labelled card, not the content —
 * editing the source happens on the source.
 */
export const SyncedPage = createReactBlockSpec(
  {
    type: "syncedPage",
    propSchema: {
      pageId: { default: "" },
      title: { default: "" },
    },
    content: "none",
  },
  {
    render: (props) => (
      <SyncedPagePicker
        pageId={String(props.block.props.pageId ?? "")}
        title={String(props.block.props.title ?? "")}
        onPick={(pageId, title) =>
          props.editor.updateBlock(props.block, { props: { pageId, title } })
        }
      />
    ),
  }
);

/**
 * Content that appears only for a matching audience. The space defines
 * variables (audience=internal, region=eu, …); this block names one value
 * and its children render only when the space's value matches. The editor
 * always shows the content — writers must see what they wrote.
 */
export const IfVar = createReactBlockSpec(
  {
    type: "ifvar",
    propSchema: {
      name: { default: "audience" },
      equals: { default: "" },
    },
    content: "inline",
  },
  {
    render: (props) => (
      <div className="rounded-lg border border-dashed border-line px-3 py-2">
        <span className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-faint">
          <SlidersHorizontal size={11} />
          only when
          <input
            className="w-24 rounded border border-line bg-bg px-1.5 py-0.5 font-mono text-[11px] text-ink"
            value={String(props.block.props.name ?? "")}
            onChange={(e) =>
              props.editor.updateBlock(props.block, { props: { name: e.target.value } })
            }
          />
          =
          <input
            className="w-24 rounded border border-line bg-bg px-1.5 py-0.5 font-mono text-[11px] text-ink"
            value={String(props.block.props.equals ?? "")}
            onChange={(e) =>
              props.editor.updateBlock(props.block, { props: { equals: e.target.value } })
            }
          />
        </span>
        <span className="text-[15px]" ref={props.contentRef} />
      </div>
    ),
  }
);

export const octavoSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    callout: Callout(),
    expandable: Expandable(),
    step: Step(),
    math: MathBlock(),
    drawio: Drawio(),
    themeImage: ThemeImage(),
    model3d: Model3DBlock(),
    apiRequest: ApiRequestBlock(),
    sketch: Sketch(),
    syncedPage: SyncedPage(),
    ifvar: IfVar(),
  },
  styleSpecs: {
    ...defaultStyleSpecs,
    note: NoteStyle,
  },
});

export type OctavoEditor = typeof octavoSchema.BlockNoteEditor;

export function customSlashItems(
  editor: OctavoEditor
): DefaultReactSuggestionItem[] {
  // The schema-specific generics fight the helper's signature; the runtime
  // contract is identical, so erase them at this one boundary.
  const insert = insertOrUpdateBlockForSlashMenu as (
    e: unknown,
    b: unknown
  ) => void;
  const make = (
    title: string,
    subtext: string,
    icon: React.ReactElement,
    type:
      | "callout" | "expandable" | "step" | "math"
      | "drawio" | "themeImage" | "model3d"
      | "sketch" | "syncedPage" | "ifvar",
    props?: Record<string, string>
  ): DefaultReactSuggestionItem => ({
    title,
    subtext,
    icon,
    group: "Docs blocks",
    onItemClick: () => insert(editor, { type, props }),
  });
  return [
    make("Callout", "Highlight a note for readers", <Info size={18} />, "callout", { tone: "info" }),
    make("Warning callout", "Make a hazard impossible to miss", <AlertTriangle size={18} />, "callout", { tone: "warning" }),
    make("Expandable", "Collapse detail behind a title", <ChevronRight size={18} />, "expandable"),
    make("Step", "Numbered step for guides", <ListOrdered size={18} />, "step"),
    make("Math", "Display formula (KaTeX)", <Sigma size={18} />, "math"),
    make("Draw.io diagram", "A diagram saved in this page", <PenTool size={18} />, "drawio"),
    make("Theme-aware image", "A different image in light and dark", <ImageIcon size={18} />, "themeImage"),
    make("3D model", "A rotatable scene for this discipline", <Boxes size={18} />, "model3d", { kind: "architecture" }),
    make("Sketch", "Draw here; readers get an image", <Shapes size={18} />, "sketch"),
    make("Embed a page", "Another page's content, always current", <FileInput size={18} />, "syncedPage"),
    make("Audience block", "Shown only when a space variable matches", <SlidersHorizontal size={18} />, "ifvar"),
  ];
}
