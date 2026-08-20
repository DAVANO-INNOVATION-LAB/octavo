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
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Info,
  ListOrdered,
  OctagonAlert,
  Sigma,
} from "lucide-react";

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

export const octavoSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    callout: Callout(),
    expandable: Expandable(),
    step: Step(),
    math: MathBlock(),
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
    type: "callout" | "expandable" | "step" | "math",
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
  ];
}
