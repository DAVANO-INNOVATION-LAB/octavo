"use client";

import { useRef, useState } from "react";
import { Image as ImageIcon, X } from "lucide-react";

/**
 * The cover control a writer sees. Quiet until used: a small button above
 * the title; open it and there are six ink washes and an upload. The form
 * posts to a server action, so the whole thing degrades to a plain form.
 */
export function CoverPicker({
  pageId,
  cover,
  action,
}: {
  pageId: string;
  cover: string;
  action: (formData: FormData) => void;
}) {
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = (value: string) => {
    const fd = new FormData();
    fd.set("page", pageId);
    fd.set("cover", value);
    action(fd);
  };

  async function upload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      if (!res.ok) return;
      const { url } = (await res.json()) as { url: string };
      submit(url);
    } finally {
      setUploading(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mb-2 inline-flex items-center gap-1.5 text-xs text-faint transition-colors hover:text-accent print:hidden"
      >
        <ImageIcon size={12} />
        {cover ? "Change cover" : "Add cover"}
      </button>
    );
  }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface p-2 print:hidden">
      {["dawn", "vermilion", "moss", "indigo", "slate", "night"].map((name) => (
        <button
          key={name}
          onClick={() => submit(`preset:${name}`)}
          title={name}
          className={`cover-wash cover-${name} h-8 w-12 rounded-md border transition-transform hover:-translate-y-px ${
            cover === `preset:${name}` ? "border-accent" : "border-line"
          }`}
        />
      ))}
      <button
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        className="h-8 rounded-md border border-line px-2.5 text-xs text-muted hover:text-ink disabled:opacity-60"
      >
        {uploading ? "Uploading…" : "Upload…"}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
        }}
      />
      {cover && (
        <button
          onClick={() => submit("")}
          title="Remove cover"
          className="h-8 rounded-md border border-line px-2 text-faint hover:text-ink"
        >
          <X size={13} />
        </button>
      )}
      <button
        onClick={() => setOpen(false)}
        className="ml-auto h-8 px-2 text-xs text-faint hover:text-ink"
      >
        Done
      </button>
    </div>
  );
}
