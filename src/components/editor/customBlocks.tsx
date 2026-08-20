"use client";

import {
  BlockNoteSchema,
  defaultBlockSpecs,
  insertOrUpdateBlockForSlashMenu,
} from "@blocknote/core";
import {
  createReactBlockSpec,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import katex from "katex";
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Info,
  ListOrdered,
  OctagonAlert,
  PenTool,
  Sigma,
} from "lucide-react";

const DRAWIO_ORIGIN = "https://embed.diagrams.net";

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
      if (e.origin !== DRAWIO_ORIGIN) return;
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
          DRAWIO_ORIGIN
        );
        setStatus("");
      } else if (msg.event === "save") {
        pendingXml.current = msg.xml ?? pendingXml.current;
        setStatus("Rendering…");
        frame.contentWindow.postMessage(
          JSON.stringify({ action: "export", format: "xmlsvg" }),
          DRAWIO_ORIGIN
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
          src={`${DRAWIO_ORIGIN}/?embed=1&proto=json&spin=1&ui=min&saveAndExit=1&noExitBtn=0`}
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

export const octavoSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    callout: Callout(),
    expandable: Expandable(),
    step: Step(),
    math: MathBlock(),
    drawio: Drawio(),
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
    type: "callout" | "expandable" | "step" | "math" | "drawio",
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
  ];
}
