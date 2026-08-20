"use client";

import { useMemo } from "react";
import {
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  useCreateBlockNote,
} from "@blocknote/react";
import { filterSuggestionItems, type PartialBlock } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
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
    group: "Link a page",
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
}: {
  initialContent: string;
  onChange: (blocks: unknown[]) => void;
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

  const editor = useCreateBlockNote({
    schema: octavoSchema,
    initialContent: parsed,
    uploadFile,
    pasteHandler: smartPaste as never,
  });
  const theme = useOctavoTheme();

  return (
    <div className="octavo-editor">
      <BlockNoteView
        editor={editor}
        theme={theme}
        slashMenu={false}
        onChange={() => onChange(editor.document as unknown[])}
      >
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) =>
            filterSuggestionItems(
              [
                ...getDefaultReactSlashMenuItems(editor),
                ...customSlashItems(editor),
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
