"use client";

import { useMemo } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { useOctavoTheme } from "@/lib/theme-store";
import { BlockNoteView } from "@blocknote/mantine";
import type { PartialBlock } from "@blocknote/core";
import "@blocknote/mantine/style.css";

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
  const parsed = useMemo<PartialBlock[] | undefined>(() => {
    try {
      const blocks = JSON.parse(initialContent);
      return Array.isArray(blocks) && blocks.length > 0 ? blocks : undefined;
    } catch {
      return undefined;
    }
  }, [initialContent]);

  const editor = useCreateBlockNote({ initialContent: parsed, uploadFile });
  const theme = useOctavoTheme();

  return (
    <div className="octavo-editor">
      <BlockNoteView
        editor={editor}
        theme={theme}
        onChange={() => onChange(editor.document as unknown[])}
      />
    </div>
  );
}
