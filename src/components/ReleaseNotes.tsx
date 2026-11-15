"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import type { ReleaseNote } from "@/lib/release-notes";
type State={userId:string;version:string;previousVersion:string|null;history:ReleaseNote[];unread:ReleaseNote[]};
export function ReleaseNotes(){
 const path=usePathname(), dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null);
 const generation=useRef(0),restoreFocus=useRef<HTMLElement|null>(null);
 const [data,setData]=useState<State|null>(null),[all,setAll]=useState(false),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 useEffect(()=>{let active=true;generation.current++;dialog.current?.close();const controller=new AbortController();fetch('/api/release-notes',{cache:'no-store',signal:controller.signal}).then(async r=>r.ok?await r.json():null).then((value:State|null)=>{if(!active)return;setData(value);setBusy(false);setError("");if(!value){dialog.current?.close();return;}if(value.unread.length){restoreFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;setAll(false);dialog.current?.showModal();}}).catch(()=>{});return()=>{active=false;controller.abort();};},[path]);
 async function close(){if(busy)return;const current=generation.current;setBusy(true);setError("");try{if(data?.unread.length){const r=await fetch('/api/release-notes',{method:'POST',headers:{'x-octavo-version':data.version,'x-octavo-user':data.userId}});if(current!==generation.current)return;if(!r.ok)throw new Error();setData(d=>d?{...d,unread:[]}:d);}if(current!==generation.current)return;dialog.current?.close();restoreFocus.current?.focus({preventScroll:true});}catch{if(current===generation.current)setError("Could not save your acknowledgement. Reload to check your account and version, or close without saving.");}finally{if(current===generation.current)setBusy(false);}}
 return <><button ref={trigger} type="button" hidden={!data} className="text-xs text-muted underline underline-offset-4" onClick={()=>{restoreFocus.current=trigger.current;setAll(true);setError("");dialog.current?.showModal();}}>Release notes</button>
 <dialog ref={dialog} aria-labelledby="release-title" aria-describedby="release-description" onCancel={e=>{e.preventDefault();void close();}} className="text-left text-base leading-normal m-auto w-[calc(100%-2rem)] max-w-xl max-h-[85dvh] overflow-y-auto rounded-xl border border-line bg-bg p-6 text-ink shadow-xl backdrop:bg-black/50">
 <h2 id="release-title" className="text-xl font-semibold">{all?'Release history':"What’s new"}</h2>
 <p id="release-description" className="mt-1 text-sm text-muted">Octavo {data?.version}{!all&&data?.previousVersion?` · Since ${data.previousVersion}`:''}</p>
 {(all?data?.history:data?.unread)?.map(note=><section key={note.version} className="mt-5 border-t border-line pt-4"><h3 className="font-semibold">{note.version} · {note.title}</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{note.changes.map(s=><li key={s}>{s}</li>)}</ul><h4 className="mt-3 text-sm font-semibold">Upgrade notes</h4><ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted">{note.upgrade.map(s=><li key={s}>{s}</li>)}</ul></section>)}
 {error&&<p role="alert" className="mt-4 text-sm">{error}</p>}
 <div className="mt-6 flex flex-wrap justify-end gap-3">{!all&&<button type="button" className="text-sm underline" onClick={()=>setAll(true)}>All releases</button>}{error&&<button type="button" className="text-sm underline" onClick={()=>{dialog.current?.close();restoreFocus.current?.focus({preventScroll:true});}}>Close without saving</button>}<button autoFocus type="button" disabled={busy} className="rounded-md bg-accent px-4 py-2 text-sm text-accent-ink disabled:opacity-50" onClick={()=>void close()}>{busy?'Saving…':'Got it'}</button></div>
 </dialog></>;
}
