"use client";

import { useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";

/** A quiet "was this helpful?" — one vote, optional note, no tracking. */
export function Feedback({ pageId }: { pageId: string }) {
  const [state, setState] = useState<"idle" | "asking" | "done">("idle");
  const [helpful, setHelpful] = useState(true);
  const [note, setNote] = useState("");

  async function send(wasHelpful: boolean, text = "") {
    setHelpful(wasHelpful);
    await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pageId, helpful: wasHelpful, note: text }),
    }).catch(() => {});
  }

  if (state === "done")
    return (
      <p className="mt-12 text-center text-xs text-faint print:hidden">
        Thank you — noted.
      </p>
    );

  return (
    <div className="mt-12 flex flex-col items-center gap-3 border-t border-line pt-6 print:hidden">
      {state === "idle" ? (
        <>
          <p className="text-xs text-faint">Was this page helpful?</p>
          <div className="flex gap-2">
            <button
              onClick={async () => { await send(true); setState("done"); }}
              className="flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-xs text-muted transition-colors hover:border-line-strong hover:text-ink"
            >
              <ThumbsUp size={13} />
              Yes
            </button>
            <button
              onClick={() => { setHelpful(false); setState("asking"); }}
              className="flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-xs text-muted transition-colors hover:border-line-strong hover:text-ink"
            >
              <ThumbsDown size={13} />
              Not really
            </button>
          </div>
        </>
      ) : (
        <form
          className="w-full max-w-md"
          onSubmit={async (e) => {
            e.preventDefault();
            await send(helpful, note);
            setState("done");
          }}
        >
          <p className="mb-2 text-center text-xs text-faint">
            What was missing? (optional)
          </p>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={2000}
            className="w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent"
          />
          <div className="mt-2 flex justify-center gap-2">
            <button className="h-8 rounded-md bg-accent px-3 text-xs font-medium text-accent-ink">
              Send
            </button>
            <button
              type="button"
              onClick={async () => { await send(false); setState("done"); }}
              className="h-8 rounded-md px-3 text-xs text-muted hover:text-ink"
            >
              Skip
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
