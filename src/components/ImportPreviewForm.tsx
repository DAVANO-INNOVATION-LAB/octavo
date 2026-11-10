"use client";
import { useRef,useState } from "react";
import type { ImportPreview } from "@/lib/import-preview";
export function ImportPreviewForm() {
  const [preview,setPreview]=useState<ImportPreview|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const sequence=useRef(0);
  return <form action="/api/import" method="post" encType="multipart/form-data" className="mt-8 space-y-4 rounded-2xl border border-line bg-surface p-6" onSubmit={async e=>{
    if(preview&&!preview.errors.length)return;
    e.preventDefault();const request=++sequence.current;setBusy(true);setError("");
    try {const response=await fetch("/api/import/preview",{method:"POST",body:new FormData(e.currentTarget)});const body=await response.json();if(request!==sequence.current)return;if(!response.ok)throw new Error(body.error);setPreview(body);}catch(e){if(request===sequence.current)setError(e instanceof Error?e.message:"Preview failed");}finally{if(request===sequence.current)setBusy(false);}
  }}>
  <label className="block">File<input type="file" name="file" required accept=".zip,.md,.markdown,.txt,.json,.docx,.ipynb" className="mt-2 block w-full text-sm" onChange={()=>{sequence.current++;setPreview(null);setError("");setBusy(false);}}/></label>
  <label className="block">Space name (optional)<input name="name" className="mt-1 w-full rounded-lg border border-line bg-bg p-2"/></label>
  {error&&<p role="alert">{error}</p>}{preview&&<section className="space-y-3"><h2 className="font-semibold">Import preview</h2><p>{preview.pages.length} pages · {preview.attachments} attachment entries. Nothing has been imported yet.</p><ul className="max-h-64 overflow-auto text-sm">{preview.pages.map((p,i)=><li key={i}>{p.title} · {p.blocks} blocks</li>)}</ul>{preview.warnings.map((w,i)=><p key={i} className="text-sm text-muted">Warning: {w}</p>)}{preview.errors.map((w,i)=><p key={i} role="alert">{w}</p>)}<input type="hidden" name="previewDigest" value={preview.digest}/></section>}
  <button disabled={busy||Boolean(preview?.errors.length)} className="w-full rounded-lg bg-accent p-3 text-accent-ink disabled:opacity-50">{busy?"Checking import…":preview?"Confirm and import":"Preview import"}</button>
  </form>;
}
