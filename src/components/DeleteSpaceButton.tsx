"use client";

import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { deleteSpaceAction } from "@/app/actions";

function Confirm({ matches }: { matches: boolean }) {
  const { pending } = useFormStatus();
  return <button disabled={!matches || pending} className="rounded-lg bg-accent px-4 py-2 text-sm text-accent-ink disabled:opacity-40">{pending ? "Moving to Trash…" : "Move to Trash"}</button>;
}

export function DeleteSpaceButton({ slug, name }: { slug: string; name: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirmation, setConfirmation] = useState("");
  return <>
    <button type="button" onClick={() => { setConfirmation(""); dialog.current?.showModal(); }} className="mt-4 rounded-lg border border-accent/40 px-4 py-2 text-sm text-accent">Delete this space</button>
    <dialog ref={dialog} aria-labelledby="delete-space-title" className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-2xl border border-line bg-surface p-6 text-ink shadow-2xl backdrop:bg-black/60">
      <h2 id="delete-space-title" className="text-xl font-semibold">Move “{name}” to Trash?</h2>
      <p className="mt-3 text-sm text-muted">This hides the space and all its pages from readers. Pages, files, history, and permissions are kept. A space administrator can restore it from Trash.</p>
      <form action={deleteSpaceAction} className="mt-5">
        <input type="hidden" name="slug" value={slug} />
        <label className="block text-sm">Type <strong>{name}</strong> to confirm
          <input autoComplete="off" name="confirmation" value={confirmation} onChange={e => setConfirmation(e.target.value)} className="mt-2 w-full rounded-lg border border-line bg-bg px-3 py-2" />
        </label>
        <div className="mt-5 flex justify-end gap-3">
          <button type="button" onClick={() => dialog.current?.close()} className="rounded-lg border border-line px-4 py-2 text-sm">Cancel</button>
          <Confirm matches={confirmation === name} />
        </div>
      </form>
    </dialog>
  </>;
}
