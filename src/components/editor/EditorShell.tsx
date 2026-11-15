"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useCollab } from "./useCollab";
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

type Status = "saved" | "saving" | "error" | "conflict";
type Patch = { title?: string; content?: unknown[] };
type Draft = { pageId: string; title: string; content: unknown[]; expectedRevision: number; expectedEpoch: number; savedAt: string };

export function EditorShell({
  pageId,
  spaceSlug,
  pageSlug,
  initialTitle,
  initialContent,
  initialRevision,
  initialEpoch,
  initialUserId,
  collaborationEnabled,
  modelKind,
}: {
  pageId: string;
  spaceSlug: string;
  pageSlug: string;
  initialTitle: string;
  initialContent: string;
  initialRevision: number;
  initialEpoch: number;
  initialUserId: string;
  collaborationEnabled: boolean;
  modelKind?: string;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [status, setStatus] = useState<Status>("saved");
  // Co-editing is on unless this deployment turned it off or the socket
  // cannot be reached; either way the editor still opens and still saves.
  const { session, status: link, peers, failed } = useCollab(pageId, collaborationEnabled);
  const router = useRouter();
  const slugRef = useRef(pageSlug);
  const pendingRef = useRef<Patch>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revisionRef = useRef(initialRevision);
  const epochRef = useRef(initialEpoch);
  const inFlightRef = useRef(false);
  const bodyFlightRef = useRef(false);
  const bodyEditRef = useRef(0);
  const bodySavedRef = useRef(0);
  const titleTokenRef = useRef(initialTitle);
  const flushBodyRef = useRef<() => void>(() => {});
  const blockedRef = useRef(false);
  const [recoveryUnavailable, setRecoveryUnavailable] = useState(false);
  const [recovered, setRecovered] = useState<{key:string;draft:Draft}[]>([]);
  const storagePrefix = `octavo-editor-draft:${initialUserId}:${pageId}:`;
  const draftKeyRef = useRef("");
  const currentRef = useRef<{title:string;content:unknown[]}>({
    title: initialTitle,
    content: (() => { try { const value=JSON.parse(initialContent);return Array.isArray(value)?value:[]; } catch { return []; } })(),
  });
  const makeDraft = useCallback((): Draft => ({ pageId, ...currentRef.current,
    expectedRevision: revisionRef.current, expectedEpoch: epochRef.current, savedAt: new Date().toISOString() }), [pageId]);
  const persistDraft = useCallback(() => {
    try {
      if (!draftKeyRef.current) draftKeyRef.current=storagePrefix+crypto.randomUUID();
      window.localStorage.setItem(draftKeyRef.current, JSON.stringify(makeDraft()));
    }
    catch { setRecoveryUnavailable(true); }
  }, [makeDraft, storagePrefix]);
  const clearDraft = useCallback(() => {
    try { window.localStorage.removeItem(draftKeyRef.current); } catch { /* Keep conservative recovery record. */ }
  }, []);
  const download = useCallback((draft: Draft) => {
    const url=URL.createObjectURL(new Blob([JSON.stringify(draft,null,2)],{type:"application/json"}));
    const anchor=document.createElement("a");anchor.href=url;anchor.download=`octavo-${pageId}-unsaved-draft.json`;anchor.click();
    setTimeout(()=>URL.revokeObjectURL(url),0);
  }, [pageId]);

  const flush = useCallback(async () => {
    if (inFlightRef.current || blockedRef.current) return;
    inFlightRef.current = true;
    try {
      // Never send concurrent saves from this editor. Edits made while a request
      // is pending are drained only after its returned revision is accepted.
      while (!blockedRef.current && Object.keys(pendingRef.current).length) {
        const pending = pendingRef.current;
        pendingRef.current = {};
        persistDraft();
        setStatus("saving");
        try {
          const res = await fetch(`/api/pages/${pageId}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(session?.persistence === "barrier-v1"
              ? {title:pending.title,expectedTitle:titleTokenRef.current,expectedEpoch:session.epoch}
              : { ...pending, expectedRevision: revisionRef.current, expectedEpoch: epochRef.current }),
          });
          if (!res.ok) {
            pendingRef.current = { ...pending, ...pendingRef.current };
            blockedRef.current = true;
            setStatus(res.status === 409 || res.status === 428 ? "conflict" : "error");
            persistDraft();
            break;
          }
          const data = await res.json();
          if (!Number.isSafeInteger(data.revision) || !Number.isSafeInteger(data.epoch)) throw new Error("Missing save revision");
          revisionRef.current=data.revision;epochRef.current=data.epoch;
          if (pending.title !== undefined) titleTokenRef.current=data.title ?? pending.title;
          // An epoch rejection can arrive over the socket while this PATCH waits.
          if (blockedRef.current) { persistDraft(); break; }
          if (data.slug && data.slug !== slugRef.current) {
            slugRef.current = data.slug;
            window.history.replaceState(null, "", `/${spaceSlug}/${data.slug}/edit`);
          }
          if (!Object.keys(pendingRef.current).length && bodySavedRef.current === bodyEditRef.current) { clearDraft(); setStatus("saved"); }
        } catch {
          pendingRef.current = { ...pending, ...pendingRef.current };
          blockedRef.current = true;
          setStatus("error");
          persistDraft();
          break;
        }
      }
    } finally { inFlightRef.current = false; }
  }, [pageId, spaceSlug, persistDraft, clearDraft,session]);

  const flushBody = useCallback(async () => {
    const shared=session;
    if (shared?.persistence !== "barrier-v1" || bodyFlightRef.current || blockedRef.current || bodySavedRef.current === bodyEditRef.current) return;
    bodyFlightRef.current=true;
    const edit=bodyEditRef.current;
    try {
      const ack=await shared.provider.persist();
      if (ack.epoch !== shared.epoch) throw new Error("Persistence epoch changed");
      if (blockedRef.current) return;
      bodySavedRef.current=edit;
      if (bodySavedRef.current === bodyEditRef.current && !Object.keys(pendingRef.current).length && !inFlightRef.current) {
        clearDraft();setStatus("saved");
      } else persistDraft();
    } catch {
      blockedRef.current=true;setStatus("conflict");persistDraft();
    } finally {
      bodyFlightRef.current=false;
      if (!blockedRef.current && bodySavedRef.current !== bodyEditRef.current) queueMicrotask(()=>flushBodyRef.current());
    }
  }, [clearDraft,persistDraft,session]);
  useEffect(()=>{flushBodyRef.current=()=>{void flushBody();};},[flushBody]);

  const queue = useCallback((patch: Patch) => {
    currentRef.current = { ...currentRef.current, ...patch };
    if (patch.content !== undefined && session?.persistence === "barrier-v1") {
      bodyEditRef.current++;
      if (patch.title !== undefined) pendingRef.current={...pendingRef.current,title:patch.title};
    } else pendingRef.current = { ...pendingRef.current, ...patch };
    persistDraft();
    if (blockedRef.current) return;
    setStatus("saving");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(()=>{void flush();flushBodyRef.current();}, 700);
  }, [flush, persistDraft,session]);

  useEffect(() => {
    let alive=true;
    if (!draftKeyRef.current) draftKeyRef.current=storagePrefix+crypto.randomUUID();
    try {
      const drafts: {key:string;draft:Draft}[]=[];
      for(let i=0;i<window.localStorage.length;i++) {
        const key=window.localStorage.key(i);
        if(!key?.startsWith(storagePrefix) || key===draftKeyRef.current)continue;
        try { const draft=JSON.parse(window.localStorage.getItem(key) ?? "null");
          if(draft?.pageId===pageId && typeof draft.title==="string" && Array.isArray(draft.content))drafts.push({key,draft});
        } catch { /* Do not erase a recovery record that cannot be decoded. */ }
      }
      queueMicrotask(()=>{if(alive)setRecovered(drafts);});
    } catch { queueMicrotask(()=>{if(alive)setRecoveryUnavailable(true);}); }
    const stale = (event: Event) => {
      if ((event as CustomEvent<{pageId?:string}>).detail?.pageId !== pageId) return;
      blockedRef.current=true;setStatus("conflict");persistDraft();
      if(timerRef.current)clearTimeout(timerRef.current);
    };
    const hasUnsaved=()=>Object.keys(pendingRef.current).length || inFlightRef.current || blockedRef.current || bodySavedRef.current !== bodyEditRef.current;
    const onHide = (event: BeforeUnloadEvent) => {
      if (hasUnsaved()) {
        persistDraft();event.preventDefault();event.returnValue="";
      }
    };
    window.addEventListener("beforeunload",onHide);
    window.addEventListener("octavo:collab-stale",stale);
    return () => {
      alive=false;
      window.removeEventListener("beforeunload",onHide);window.removeEventListener("octavo:collab-stale",stale);
      if(timerRef.current)clearTimeout(timerRef.current);
      // Navigation never fires an untracked last-writer-wins request.
      if(hasUnsaved())persistDraft();
    };
  }, [pageId,storagePrefix,persistDraft]);

  useEffect(() => {
    router.prefetch(`/${spaceSlug}/${slugRef.current}`);
  }, [router, spaceSlug]);

  return (
    <div>
      <div className="mb-1 flex items-center justify-end">
        <span
          className={`text-[11px] uppercase tracking-[0.08em] ${
            status === "error" || status === "conflict" ? "text-accent" : "text-faint"
          }`}
        >
          {status === "saving" ? "Saving…" : status === "conflict" ? "Page changed — autosave paused" : status === "error" ? "Save failed — autosave paused" : "Saved"}
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
      {(status === "conflict" || status === "error") && (
        <section role="alert" className="my-3 rounded-lg border border-line p-3 text-sm">
          <p>Your draft has not been discarded. Download it before reloading or reconciling with the current page. No newer server content will be overwritten automatically.</p>
          <p className="mt-1 text-xs text-muted">{recoveryUnavailable ? "Browser recovery storage is unavailable. Download your draft before leaving." : "An unsaved recovery copy is retained in this browser, scoped to your account and this page."}</p>
          <button type="button" onClick={()=>download(makeDraft())} className="mt-2 rounded border border-line px-3 py-1">Download my draft</button>
          {status === "error" && <button type="button" onClick={()=>{blockedRef.current=false;void flush();}} className="ml-2 rounded border border-line px-3 py-1">Retry save</button>}
        </section>
      )}
      {recovered.length > 0 && (
        <section aria-label="Recovered local drafts" className="my-3 rounded-lg border border-line p-3 text-sm">
          <p>Unsaved drafts from another session are stored in this browser. They are not applied automatically.</p>
          {recovered.map(({key,draft})=><div key={key} className="mt-2 flex gap-2">
            <button type="button" onClick={()=>download(draft)} className="rounded border border-line px-3 py-1">Download draft {draft.savedAt}</button>
            <button type="button" onClick={()=>{if(window.confirm("Discard this browser-local draft? Download it first if you need to keep it.")){try{window.localStorage.removeItem(key);setRecovered(items=>items.filter(item=>item.key!==key));}catch{setRecoveryUnavailable(true);}}}} className="rounded border border-line px-3 py-1">Discard draft</button>
          </div>)}
        </section>
      )}
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
      {collaborationEnabled && !session && !failed ? <p className="text-sm text-muted">Opening shared editor…</p> : <Editor
        pageId={pageId}
        collab={session}
        modelKind={modelKind}
        initialContent={initialContent}
        onChange={(blocks) => queue({ content: blocks })}
      />}
    </div>
  );
}
