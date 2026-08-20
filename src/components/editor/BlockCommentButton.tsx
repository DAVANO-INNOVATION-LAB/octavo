"use client";

import { useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { useComponentsContext, useBlockNoteEditor } from "@blocknote/react";
import { CommentBox } from "@/components/CommentBox";

/** Plain text of a block, for quoting the passage a thread hangs from. */
function blockText(block: { content?: unknown }): string {
  const walk = (nodes: unknown): string => {
    if (!Array.isArray(nodes)) return "";
    return nodes
      .map((n) => {
        const node = n as { type?: string; text?: string; content?: unknown };
        if (node.type === "text") return node.text ?? "";
        if (node.content) return walk(node.content);
        return "";
      })
      .join("");
  };
  return walk(block.content).trim();
}

/**
 * Starts a comment thread on the block the side menu is pointing at.
 *
 * The passage is copied alongside the comment so the thread still reads if
 * the block is later rewritten or deleted — a note about a paragraph nobody
 * can see any more is worse than no note.
 */
export function BlockCommentButton({ pageId }: { pageId: string }) {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle"
  );

  async function submit() {
    const block = editor.getTextCursorPosition().block;
    if (!body.trim() || !block) return;
    setState("saving");
    try {
      const res = await fetch("/api/comments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pageId,
          blockId: block.id,
          anchorText: blockText(block).slice(0, 300),
          body,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setState("saved");
      setBody("");
      setTimeout(() => {
        setOpen(false);
        setState("idle");
      }, 900);
    } catch {
      setState("error");
    }
  }

  return (
    <>
      <Components.SideMenu.Button
        label="Comment on this block"
        icon={
          <MessageSquarePlus
            size={16}
            className="cursor-pointer text-[var(--faint)] hover:text-[var(--accent)]"
            onClick={() => setOpen(true)}
          />
        }
      />

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-line bg-surface p-4 shadow-pop"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
              Comment on this passage
            </p>
            <div className="mt-3">
              <CommentBox
                autoFocus
                name="body"
                rows={3}
                value={body}
                onValueChange={setBody}
                placeholder="What should a reader know about this block? Use @ to mention someone."
                className="w-full resize-y rounded-lg border border-line bg-bg px-3 py-2 text-sm leading-relaxed text-ink outline-none transition-colors placeholder:text-faint focus:border-accent"
              />
            </div>
            <div className="mt-3 flex items-center justify-end gap-2">
              {state === "error" && (
                <span className="mr-auto text-xs text-faint">
                  That did not save — try again.
                </span>
              )}
              {state === "saved" && (
                <span className="mr-auto text-xs text-accent">
                  Added to the discussion.
                </span>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="h-8 rounded-md border border-line px-3 text-xs text-muted hover:bg-wash"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={!body.trim() || state === "saving"}
                className="h-8 rounded-md bg-accent px-3.5 text-xs font-medium text-accent-ink disabled:opacity-50"
              >
                {state === "saving" ? "Saving…" : "Comment"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
