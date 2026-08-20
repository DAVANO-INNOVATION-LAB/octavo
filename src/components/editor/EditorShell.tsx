"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useCollab } from "./useCollab";
import { collabEnabled } from "@/lib/client-config";
import { Users, WifiOff } from "lucide-react";

const Editor = dynamic(() => import("./Editor"), {
  ssr: false,
  loading: () => (
    <div className="space-y-3 pt-1">
      <div className="h-4 w-2/3 animate-pulse rounded bg-surface-2" />
      <div className="h-4 w-full animate-pulse rounded bg-surface-2" />
      <div className="h-4 w-5/6 animate-pulse rounded bg-surface-2" />
    </div>
  ),
});

type Status = "saved" | "saving" | "error";

export function EditorShell({
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
  const [title, setTitle] = useState(initialTitle);
  const [status, setStatus] = useState<Status>("saved");
  // Co-editing is on unless this deployment turned it off or the socket
  // cannot be reached; either way the editor still opens and still saves.
  const { session, status: link, peers, failed } = useCollab(pageId, collabEnabled());
  const router = useRouter();
  const slugRef = useRef(pageSlug);
  const pendingRef = useRef<{ title?: string; content?: unknown[] }>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    const pending = pendingRef.current;
    pendingRef.current = {};
    if (pending.title === undefined && pending.content === undefined) return;
    setStatus("saving");
    try {
      const res = await fetch(`/api/pages/${pageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pending),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      setStatus("saved");
      // Draft slugs follow the title; keep the URL in sync without a reload.
      if (data.slug && data.slug !== slugRef.current) {
        slugRef.current = data.slug;
        window.history.replaceState(null, "", `/${spaceSlug}/${data.slug}/edit`);
      }
    } catch {
      setStatus("error");
    }
  }, [pageId, spaceSlug]);

  const queue = useCallback(
    (patch: { title?: string; content?: unknown[] }) => {
      pendingRef.current = { ...pendingRef.current, ...patch };
      setStatus("saving");
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, 700);
    },
    [flush]
  );

  // Flush on unmount / tab close.
  useEffect(() => {
    const onHide = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      flush();
    };
    window.addEventListener("beforeunload", onHide);
    return () => {
      window.removeEventListener("beforeunload", onHide);
      onHide();
    };
  }, [flush]);

  useEffect(() => {
    router.prefetch(`/${spaceSlug}/${slugRef.current}`);
  }, [router, spaceSlug]);

  return (
    <div>
      <div className="mb-1 flex items-center justify-end">
        <span
          className={`text-[11px] uppercase tracking-[0.08em] ${
            status === "error" ? "text-accent" : "text-faint"
          }`}
        >
          {status === "saving" ? "Saving…" : status === "error" ? "Save failed — retrying on next edit" : "Saved"}
        </span>

        {/* Who else is in this document, and whether we can still hear them. */}
        {session && peers.length > 0 && (
          <span
            className="flex items-center gap-1.5 text-[11px] text-faint"
            title={peers.map((p) => p.name).join(", ")}
          >
            <Users size={12} />
            <span className="flex -space-x-1.5">
              {peers.slice(0, 4).map((p, i) => (
                <span
                  key={`${p.name}-${i}`}
                  aria-hidden
                  className="flex h-5 w-5 items-center justify-center rounded-full border border-bg text-[9px] font-semibold text-white"
                  style={{ background: p.color }}
                >
                  {p.name.slice(0, 1).toUpperCase()}
                </span>
              ))}
            </span>
            {peers.length > 4 && <span>+{peers.length - 4}</span>}
          </span>
        )}
        {session && link !== "connected" && (
          <span className="flex items-center gap-1.5 text-[11px] text-faint">
            <WifiOff size={12} />
            {link === "connecting" ? "Connecting…" : "Reconnecting — your edits are kept"}
          </span>
        )}
        {failed && (
          <span className="text-[11px] text-faint">
            Editing alone — co-editing is unavailable
          </span>
        )}
      </div>
      <textarea
        value={title}
        rows={1}
        placeholder="Untitled"
        onChange={(e) => {
          const v = e.target.value.replace(/\n/g, "");
          setTitle(v);
          queue({ title: v });
        }}
        className="wordmark mb-4 w-full resize-none overflow-hidden bg-transparent text-[2.2rem] leading-[1.15] text-ink outline-none placeholder:text-faint"
        style={{ fontVariationSettings: '"opsz" 60' }}
        onInput={(e) => {
          const el = e.currentTarget;
          el.style.height = "auto";
          el.style.height = `${el.scrollHeight}px`;
        }}
      />
      <Editor
        pageId={pageId}
        collab={session}
        initialContent={initialContent}
        onChange={(blocks) => queue({ content: blocks })}
      />
    </div>
  );
}
