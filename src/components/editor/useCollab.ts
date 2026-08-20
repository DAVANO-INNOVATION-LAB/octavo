"use client";

import { useEffect, useState } from "react";
import * as Y from "yjs";
import { CollabProvider, colorFor, type ConnectionState } from "@/lib/collab-provider";

export type CollabSession = {
  provider: CollabProvider;
  fragment: Y.XmlFragment;
  user: { name: string; color: string };
  /** True when this browser is the one that must seed an empty document. */
  seed: boolean;
};

/** The fragment name is part of the stored document; changing it orphans history. */
export const FRAGMENT = "blocknote";

/**
 * Open a collaboration session for a page, or return null when co-editing is
 * unavailable — the caller then falls back to the ordinary single-writer
 * editor rather than showing nothing.
 */
export function useCollab(pageId: string | undefined, enabled: boolean) {
  const [session, setSession] = useState<CollabSession | null>(null);
  const [status, setStatus] = useState<ConnectionState>("connecting");
  const [peers, setPeers] = useState<{ name: string; color: string }[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled || !pageId) return;
    let provider: CollabProvider | null = null;
    let cancelled = false;
    let offStatus = () => {};

    (async () => {
      // Ask the app who we are and whether we hold the seeding claim. This is
      // also the check that keeps the socket honest: if it says no here, there
      // is no point opening one.
      let who: { ok: boolean; userId: string; name: string; seed: boolean };
      try {
        const res = await fetch(
          `/api/collab/authorize?page=${encodeURIComponent(pageId)}&claim=1`
        );
        if (!res.ok) throw new Error(String(res.status));
        who = await res.json();
        if (!who.ok) throw new Error("not permitted");
      } catch {
        if (!cancelled) setFailed(true);
        return;
      }
      if (cancelled) return;

      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${window.location.host}/collab?page=${encodeURIComponent(pageId)}`;
      const doc = new Y.Doc();
      provider = new CollabProvider(url, doc);

      const user = { name: who.name, color: colorFor(who.userId) };
      provider.awareness.setLocalStateField("user", user);

      offStatus = provider.onStatus((s) => !cancelled && setStatus(s));

      const readPeers = () => {
        if (cancelled || !provider) return;
        const out: { name: string; color: string }[] = [];
        provider.awareness.getStates().forEach((state, clientId) => {
          if (clientId === doc.clientID) return;
          const u = (state as { user?: { name: string; color: string } }).user;
          if (u?.name) out.push(u);
        });
        setPeers(out);
      };
      provider.awareness.on("change", readPeers);

      setSession({
        provider,
        fragment: doc.getXmlFragment(FRAGMENT),
        user,
        seed: Boolean(who.seed),
      });
    })();

    return () => {
      cancelled = true;
      offStatus();
      provider?.destroy();
    };
  }, [pageId, enabled]);

  return { session, status, peers, failed };
}
