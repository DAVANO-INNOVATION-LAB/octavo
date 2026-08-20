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
