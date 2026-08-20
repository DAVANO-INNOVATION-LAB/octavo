import Link from "next/link";
import { Trash2 } from "lucide-react";
import type { User } from "@/lib/auth";
import { listComments } from "@/lib/data";
import { addCommentAction, deleteCommentAction } from "@/app/actions";

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

/** Quiet discussion section under technical documents. */
export function Discussion({
  pageId,
  spaceSlug,
  pageSlug,
  user,
}: {
  pageId: string;
  spaceSlug: string;
  pageSlug: string;
  user: User | null;
}) {
  const comments = listComments(pageId);

  return (
    <section id="discussion" className="mt-14 border-t border-line pt-8 print:hidden">
      <p className="mb-5 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
        Discussion
        {comments.length > 0 && (
          <span className="ml-2 font-mono text-faint">{comments.length}</span>
        )}
      </p>

      {comments.length === 0 && (
        <p className="text-sm text-faint">
          Nothing in the margins yet.
          {!user && " Sign in to leave the first note."}
        </p>
      )}

      <ul className="space-y-4">
        {comments.map((c) => (
          <li key={c.id} className="group flex gap-3">
            <span
              aria-hidden
              className="wordmark flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-full bg-accent-soft text-xs text-accent"
            >
              {c.author.slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-faint">
                <span className="font-medium text-muted">{c.author}</span>
                <span className="mx-1.5">·</span>
                {timeAgo(c.created_at)}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-[15px] leading-relaxed text-ink">
                {c.body}
              </p>
            </div>
            {user && (
              <form action={deleteCommentAction} className="shrink-0">
                <input type="hidden" name="id" value={c.id} />
                <input type="hidden" name="space" value={spaceSlug} />
                <input type="hidden" name="page" value={pageSlug} />
                <button
                  aria-label="Delete comment"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-faint opacity-0 transition-opacity hover:bg-accent-soft hover:text-accent group-hover:opacity-100"
                >
                  <Trash2 size={13} />
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>

      {user ? (
        <form action={addCommentAction} className="mt-6">
          <input type="hidden" name="pageId" value={pageId} />
          <input type="hidden" name="space" value={spaceSlug} />
          <textarea
            required
            name="body"
            rows={3}
            maxLength={4000}
            placeholder="Add to the discussion…"
            className="w-full resize-y rounded-lg border border-line bg-surface px-3 py-2.5 text-sm leading-relaxed text-ink outline-none transition-colors placeholder:text-faint focus:border-accent"
          />
          <div className="mt-2 flex justify-end">
            <button className="h-8 rounded-md bg-accent px-3.5 text-xs font-medium text-accent-ink shadow-card transition-transform hover:-translate-y-px">
              Post comment
            </button>
          </div>
        </form>
      ) : (
        comments.length > 0 && (
          <p className="mt-6 text-xs text-faint">
            <Link href="/login" className="text-muted underline">
              Sign in
            </Link>{" "}
            to join the discussion.
          </p>
        )
      )}
    </section>
  );
}
