"use client";

import { useEffect, useRef, useState } from "react";
import type { MentionUser } from "@/lib/mentions";

/** Names are fetched once per page and shared by every box on it. */
let cache: MentionUser[] | null = null;
let inflight: Promise<MentionUser[]> | null = null;

async function loadNames(): Promise<MentionUser[]> {
  if (cache) return cache;
  if (!inflight) {
    inflight = fetch("/api/mentions")
      .then((r) => (r.ok ? r.json() : { users: [] }))
      .then((d) => {
        cache = (d.users ?? []) as MentionUser[];
        return cache;
      })
      .catch(() => []);
  }
  return inflight;
}

/**
 * A comment field that completes names after an "@".
 *
 * The value stays plain text — the mention is the name itself, resolved when
 * the comment is rendered. That keeps a comment readable in an export, in the
 * database, and in an email, none of which can interpret markup.
 */
export function CommentBox({
  name,
  rows = 3,
  placeholder,
  className,
  autoFocus,
  value: controlled,
  onValueChange,
}: {
  name: string;
  rows?: number;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  /** Supply both to drive the field yourself (the editor posts it directly). */
  value?: string;
  onValueChange?: (v: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [own, setOwn] = useState("");
  const value = controlled ?? own;
  const setValue = (v: string) => {
    if (onValueChange) onValueChange(v);
    else setOwn(v);
  };
  const [people, setPeople] = useState<MentionUser[]>([]);
  const [query, setQuery] = useState<{ at: number; text: string } | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    loadNames().then(setPeople);
  }, []);

  /** The "@word" immediately behind the caret, if the caret is still in one. */
  function detect(el: HTMLTextAreaElement) {
    const caret = el.selectionStart ?? 0;
    const upto = el.value.slice(0, caret);
    const at = upto.lastIndexOf("@");
    if (at < 0) return setQuery(null);
    const before = at === 0 ? "" : upto[at - 1];
    if (before && !/[\s([{<"']/.test(before)) return setQuery(null);
    const text = upto.slice(at + 1);
    // A mention is one or two words; past that the author has moved on.
    if (text.includes("\n") || text.split(" ").length > 2) return setQuery(null);
    setQuery({ at, text });
    setActive(0);
  }

  const matches = query
    ? people
        .filter((p) => p.name.toLowerCase().startsWith(query.text.toLowerCase()))
        .slice(0, 6)
    : [];

  function choose(p: MentionUser) {
    const el = ref.current;
    if (!el || !query) return;
    const caret = el.selectionStart ?? 0;
    const next =
      value.slice(0, query.at) + `@${p.name} ` + value.slice(caret);
    setValue(next);
    setQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      const pos = query.at + p.name.length + 2;
      el.setSelectionRange(pos, pos);
    });
  }

  return (
    <div className="relative">
      <textarea
        ref={ref}
        required
        autoFocus={autoFocus}
        name={name}
        rows={rows}
        maxLength={4000}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          setValue(e.target.value);
          detect(e.target);
        }}
        onClick={(e) => detect(e.currentTarget)}
        onBlur={() => setTimeout(() => setQuery(null), 120)}
        onKeyDown={(e) => {
          if (!matches.length) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => (i + 1) % matches.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => (i - 1 + matches.length) % matches.length);
          } else if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            choose(matches[active]);
          } else if (e.key === "Escape") {
            setQuery(null);
          }
        }}
        className={className}
      />
      {matches.length > 0 && (
        <ul className="absolute left-2 top-full z-30 mt-1 w-56 overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-pop">
          {matches.map((p, i) => (
            <li key={p.id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(p)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                  i === active ? "bg-accent-soft text-accent" : "text-ink"
                }`}
              >
                <span
                  aria-hidden
                  className="wordmark flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] text-accent"
                >
                  {p.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="truncate">{p.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
