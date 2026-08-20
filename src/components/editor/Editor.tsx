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
      </BlockNoteView>
    </div>
  );
}
