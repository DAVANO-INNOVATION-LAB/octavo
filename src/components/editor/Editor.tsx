"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  SideMenu,
  SideMenuController,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  useCreateBlockNote,
} from "@blocknote/react";
import { filterSuggestionItems, type PartialBlock } from "@blocknote/core";
import { withCollaboration, blocksToYXmlFragment } from "@blocknote/core/yjs";
import type { CollabSession } from "./useCollab";
import { BlockNoteView } from "@blocknote/mantine";
import { BlockCommentButton } from "./BlockCommentButton";
import "@blocknote/mantine/style.css";
import "katex/dist/katex.min.css";
import { useOctavoTheme } from "@/lib/theme-store";
import { customSlashItems, octavoSchema } from "./customBlocks";
import { FileText } from "lucide-react";

type PageHit = {
  title: string;
  page_slug: string;
  space_slug: string;
  space_name: string;
};

type OctavoEditorInstance = { insertInlineContent: (c: never) => void };

async function pageLinkItems(editor: OctavoEditorInstance, query: string, stripBrackets: boolean) {
  const res = await fetch(`/api/pages/lookup?q=${encodeURIComponent(query)}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { pages: PageHit[] };
  return data.pages.map((p) => ({
    title: p.title,
    subtext: p.space_name,
    icon: <FileText size={18} />,
    // Grouped by space, not one flat list: the picker searches every space
    // the writer can read, and grouping is what makes that visible —
    // otherwise two same-titled pages from different spaces are
    // indistinguishable at the moment of choosing.
    group: p.space_name,
    onItemClick: () => {
      editor.insertInlineContent([
        {
          type: "link",
          href: `/${p.space_slug}/${p.page_slug}`,
          content: [{ type: "text", text: p.title, styles: {} }],
        },
        " ",
      ] as never);
      void stripBrackets;
    },
  }));
}

/**
 * Smart paste: a spreadsheet becomes a table, an editor's code becomes a
 * code block, and rich text from a document keeps its structure. Everything
 * else falls through to BlockNote's own handling.
 */
function smartPaste(context: {
  event: ClipboardEvent;
  editor: {
    tryParseHTMLToBlocks: (html: string) => Promise<unknown[]>;
    replaceBlocks: (ids: unknown[], blocks: unknown[]) => void;
    getTextCursorPosition: () => { block: { id: string } };
    insertBlocks: (blocks: unknown[], ref: unknown, pos: string) => void;
  };
  defaultPasteHandler: () => boolean;
}): boolean {
  const data = context.event.clipboardData;
  if (!data) return context.defaultPasteHandler();
  const html = data.getData("text/html");
  const text = data.getData("text/plain");

  // Spreadsheet cells arrive as an HTML table (and TSV in plain text).
  const isSpreadsheet =
    /<table[\s>]/i.test(html) &&
    /(office:|urn:schemas-microsoft|docs-internal|google-sheets)/i.test(html);
  // VS Code and friends stamp the clipboard with their own metadata.
  const isEditorCode =
    data.types.includes("vscode-editor-data") ||
    /<div[^>]+style="[^"]*font-family:[^"]*(monospace|Menlo|Consolas)/i.test(html);

  if (isEditorCode && text.trim()) {
    let language = "";
    try {
      const meta = data.getData("vscode-editor-data");
      if (meta) language = String(JSON.parse(meta).mode ?? "");
    } catch {
      /* no language metadata */
    }
    const current = context.editor.getTextCursorPosition().block;
    context.editor.insertBlocks(
      [
        {
          type: "codeBlock",
          props: { language },
          content: [{ type: "text", text, styles: {} }],
        },
      ],
      current,
      "after"
    );
    context.event.preventDefault();
    return true;
  }

  if (isSpreadsheet || (html && /<table[\s>]/i.test(html))) {
    // BlockNote parses HTML tables faithfully; make sure HTML wins over the
    // plain-text fallback the browser would otherwise prefer.
    void context.editor.tryParseHTMLToBlocks(html).then((blocks) => {
      const current = context.editor.getTextCursorPosition().block;
      context.editor.insertBlocks(blocks, current, "after");
    });
    context.event.preventDefault();
    return true;
  }

  return context.defaultPasteHandler();
}

async function uploadFile(file: File): Promise<string> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch("/api/upload", { method: "POST", body });
  if (!res.ok) throw new Error("Upload failed");
  const data = await res.json();
  return data.url as string;
}

export default function Editor({
  initialContent,
  onChange,
  pageId,
  collab,
  modelKind,
}: {
  initialContent: string;
  onChange: (blocks: unknown[]) => void;
  /** Absent on a page that has not been saved yet — nothing to anchor to. */
  pageId?: string;
  /** When present, the document is shared and this editor joins it. */
  collab?: CollabSession | null;
  /** What a new 3D model block starts as here; set per space in settings. */
  modelKind?: string;
}) {
  const parsed = useMemo(() => {
    try {
      const blocks = JSON.parse(initialContent);
      return Array.isArray(blocks) && blocks.length > 0
        ? (blocks as PartialBlock<typeof octavoSchema.blockSchema>[])
        : undefined;
    } catch {
      return undefined;
    }
  }, [initialContent]);

  // Under collaboration the shared document is the source of truth, and
  // passing initialContent as well would replay the page into it on every
  // join. Seeding happens once, below, and only for the browser that holds
  // the claim.
  const editor = useCreateBlockNote(
    collab
      ? (withCollaboration({
          schema: octavoSchema,
          uploadFile,
          pasteHandler: smartPaste as never,
          collaboration: {
            fragment: collab.fragment,
            user: collab.user,
            provider: { awareness: collab.provider.awareness },
          },
        }) as never)
      : {
          schema: octavoSchema,
          initialContent: parsed,
          uploadFile,
          pasteHandler: smartPaste as never,
        },
    [collab]
  );
  const theme = useOctavoTheme();

  // Put the page's existing content into an empty shared document exactly
  // once. Waiting for the first sync matters: before it, every document looks
  // empty, and seeding then would duplicate what the server already had.
  const seeded = useRef(false);
  useEffect(() => {
    if (!collab || !collab.seed || seeded.current) return;
    return collab.provider.onSynced(() => {
      if (seeded.current) return;
      seeded.current = true;
      if (collab.fragment.length > 0) return; // somebody got there first
      const blocks = parsed;
      if (!blocks || blocks.length === 0) return;
      collab.provider.doc.transact(() => {
        blocksToYXmlFragment(editor as never, blocks as never, collab.fragment);
      });
    });
  }, [collab, editor, parsed]);

  return (
    <div className="octavo-editor">
      <BlockNoteView
        editor={editor}
        theme={theme}
        slashMenu={false}
        onChange={() => onChange(editor.document as unknown[])}
      >
        {pageId && (
          <SideMenuController
            sideMenu={(props) => (
              <SideMenu {...props}>
                <BlockCommentButton pageId={pageId} />
              </SideMenu>
            )}
          />
        )}
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) =>
            filterSuggestionItems(
              [
                ...getDefaultReactSlashMenuItems(editor),
                ...customSlashItems(editor, modelKind),
              ],
              query
            )
          }
        />
        <SuggestionMenuController
          triggerCharacter="[["
          getItems={async (query) => pageLinkItems(editor, query, true)}
        />
        <SuggestionMenuController
          triggerCharacter="@"
          getItems={async (query) => pageLinkItems(editor, query, false)}
        />
      </BlockNoteView>
    </div>
  );
}
