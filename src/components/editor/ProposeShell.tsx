"use client";

import { useCallback, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { GitPullRequest } from "lucide-react";

const Editor = dynamic(() => import("./Editor"), {
  ssr: false,
  loading: () => (
    <p className="px-4 py-10 text-sm text-faint">Opening the draft…</p>
  ),
});

/**
 * An editor that proposes rather than saves.
 *
 * The ordinary editor autosaves straight to the page, which is the right
 * behaviour for someone editing their own work and the wrong one for someone
 * suggesting a change to somebody else's. Nothing here touches the page until
 * a reviewer merges it.
 */
export function ProposeShell({
  pageId,
  spaceSlug,
  pageSlug,
  initialTitle,
  initialContent,
}: {
  pageId: string;
  spaceSlug: string;
  pageSlug: string;
  initialTitle: string;
  initialContent: string;
}) {
  const router = useRouter();
  const contentRef = useRef<unknown[] | null>(null);
  const [proposedTitle, setProposedTitle] = useState(initialTitle);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");

  const onChange = useCallback((blocks: unknown[]) => {
    contentRef.current = blocks;
  }, []);

  async function submit() {
    if (!title.trim()) return;
    setState("saving");
    try {
      const res = await fetch("/api/change-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pageId,
          title,
          description,
          proposedTitle,
          proposedContent: contentRef.current ?? JSON.parse(initialContent),
        }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      router.push(`/${spaceSlug}/${pageSlug}/changes/${data.id}`);
    } catch {
      setState("error");
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl px-4 py-8 sm:px-6">
      <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
        <GitPullRequest size={13} />
        Proposing changes
      </p>
      <p className="mt-2 text-sm text-muted">
        Edit freely — the page is untouched until somebody reviews and merges
        this.
      </p>

      <input
        value={proposedTitle}
        onChange={(e) => setProposedTitle(e.target.value)}
        placeholder="Page title"
        className="wordmark mt-6 w-full border-0 bg-transparent text-[2rem] leading-tight text-ink outline-none placeholder:text-faint"
      />

      <div className="mt-4 rounded-xl border border-line">
        <Editor initialContent={initialContent} onChange={onChange} />
      </div>

      <div className="mt-8 border-t border-line pt-6">
        <label className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
          What are you proposing?
        </label>
        <input
          required
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Fix the deployment steps"
          className="mt-2 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none placeholder:text-faint focus:border-accent"
        />
        <textarea
          value={description}
          rows={3}
          maxLength={4000}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Why this change is worth making (optional)"
          className="mt-2 w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-sm leading-relaxed text-ink outline-none placeholder:text-faint focus:border-accent"
        />
        <div className="mt-3 flex items-center justify-end gap-2">
          {state === "error" && (
            <span className="mr-auto text-xs text-faint">
              That did not submit — try again.
            </span>
          )}
          <button
            type="button"
            onClick={() => router.push(`/${spaceSlug}/${pageSlug}`)}
            className="h-9 rounded-md border border-line px-3.5 text-sm text-muted hover:bg-wash"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!title.trim() || state === "saving"}
            className="h-9 rounded-md bg-accent px-4 text-sm font-medium text-accent-ink disabled:opacity-40"
          >
            {state === "saving" ? "Submitting…" : "Submit for review"}
          </button>
        </div>
      </div>
    </div>
  );
}
