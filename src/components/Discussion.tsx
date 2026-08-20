import Link from "next/link";
import { Check, CornerDownRight, Quote, RotateCcw, Trash2 } from "lucide-react";
import type { User } from "@/lib/auth";
import { listThreads, mentionableUsers, type Comment, type Thread } from "@/lib/data";
import { parseMentions, type MentionUser } from "@/lib/mentions";
import { CommentBox } from "@/components/CommentBox";
import {
  addCommentAction,
  deleteCommentAction,
  setThreadResolvedAction,
} from "@/app/actions";

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

function Initial({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="wordmark flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-full bg-accent-soft text-xs text-accent"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function Note({
  c,
  user,
  spaceSlug,
  pageSlug,
  pageId,
  people,
}: {
  c: Comment;
  user: User | null;
  spaceSlug: string;
  pageSlug: string;
  pageId: string;
  people: MentionUser[];
}) {
  const mine = user?.id === c.user_id || user?.role === "admin";
  return (
    <div className="group flex gap-3">
      <Initial name={c.author} />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-faint">
          <span className="font-medium text-muted">{c.author}</span>
          <span className="mx-1.5">·</span>
          {timeAgo(c.created_at)}
        </p>
        <p className="mt-1 whitespace-pre-wrap text-[15px] leading-relaxed text-ink">
          {parseMentions(c.body, people).map((seg, i) =>
            seg.kind === "mention" ? (
              <span
                key={i}
                className="rounded bg-accent-soft px-1 py-0.5 font-medium text-accent"
              >
                {seg.text}
              </span>
            ) : (
              <span key={i}>{seg.text}</span>
            )
          )}
        </p>
      </div>
      {mine && (
        <form action={deleteCommentAction} className="shrink-0">
          <input type="hidden" name="id" value={c.id} />
          <input type="hidden" name="pageId" value={pageId} />
          <input type="hidden" name="space" value={spaceSlug} />
          <input type="hidden" name="page" value={pageSlug} />
          <button
            aria-label="Delete comment"
            className="flex h-7 w-7 items-center justify-center rounded-md text-faint opacity-0 transition-opacity hover:bg-accent-soft hover:text-accent group-hover:opacity-100 focus:opacity-100"
          >
            <Trash2 size={13} />
          </button>
        </form>
      )}
    </div>
  );
}

function ThreadView({
  t,
  user,
  spaceSlug,
  pageSlug,
  pageId,
  live,
  people,
}: {
  t: Thread;
  user: User | null;
  spaceSlug: string;
  pageSlug: string;
  pageId: string;
  /** False when the passage this thread hung from is no longer on the page. */
  live: boolean;
  people: MentionUser[];
}) {
  const resolved = Boolean(t.root.resolved);
  return (
    <li
      id={`t-${t.root.id}`}
      data-thread-for={t.root.block_id || undefined}
      className={`scroll-mt-24 rounded-xl border px-4 py-3.5 transition-colors ${
        resolved
          ? "border-line bg-surface-2/40 opacity-70"
          : "border-line bg-surface"
      }`}
    >
      {t.root.anchor_text && (
        <p className="mb-3 flex items-start gap-2 text-xs leading-relaxed text-muted">
          <Quote size={12} className="mt-0.5 shrink-0 text-faint" />
          <span className="min-w-0">
            {live ? (
              <a
                href={`#blk-${t.root.block_id}`}
                className="border-b border-dotted border-line-strong no-underline hover:border-accent hover:text-accent"
              >
                {t.root.anchor_text}
              </a>
            ) : (
              <span className="italic">
                {t.root.anchor_text}
                <span className="ml-1.5 not-italic text-faint">
                  — this passage has since been removed
                </span>
              </span>
            )}
          </span>
        </p>
      )}

      <Note
        c={t.root}
        user={user}
        spaceSlug={spaceSlug}
        pageSlug={pageSlug}
        pageId={pageId}
        people={people}
      />

      {t.replies.length > 0 && (
        <div className="mt-3 space-y-3 border-l border-line pl-4">
          {t.replies.map((r) => (
            <Note
              key={r.id}
              c={r}
              user={user}
              spaceSlug={spaceSlug}
              pageSlug={pageSlug}
              pageId={pageId}
              people={people}
            />
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center gap-3">
        {user && !resolved && (
          <details className="min-w-0 flex-1">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-xs text-faint hover:text-accent">
              <CornerDownRight size={12} />
              Reply
            </summary>
            <form action={addCommentAction} className="mt-2">
              <input type="hidden" name="pageId" value={pageId} />
              <input type="hidden" name="space" value={spaceSlug} />
              <input type="hidden" name="parentId" value={t.root.id} />
              <CommentBox
                name="body"
                rows={2}
                placeholder="Reply… use @ to mention someone"
                className="w-full resize-y rounded-lg border border-line bg-bg px-3 py-2 text-sm leading-relaxed text-ink outline-none transition-colors placeholder:text-faint focus:border-accent"
              />
              <div className="mt-2 flex justify-end">
                <button className="h-7 rounded-md bg-accent px-3 text-xs font-medium text-accent-ink transition-transform hover:-translate-y-px">
                  Reply
                </button>
              </div>
            </form>
          </details>
        )}

        {resolved && (
          <p className="min-w-0 flex-1 text-xs text-faint">
            Resolved
            {t.root.resolver ? ` by ${t.root.resolver}` : ""}
            {t.root.resolved_at ? ` · ${timeAgo(t.root.resolved_at)}` : ""}
          </p>
        )}

        {user && (
          <form action={setThreadResolvedAction} className="shrink-0">
            <input type="hidden" name="id" value={t.root.id} />
            <input type="hidden" name="pageId" value={pageId} />
            <input type="hidden" name="space" value={spaceSlug} />
            <input type="hidden" name="page" value={pageSlug} />
            <input type="hidden" name="resolved" value={resolved ? "0" : "1"} />
            <button className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line px-2.5 text-xs text-muted transition-colors hover:border-accent hover:text-accent">
              {resolved ? <RotateCcw size={12} /> : <Check size={12} />}
              {resolved ? "Reopen" : "Resolve"}
            </button>
          </form>
        )}
      </div>
    </li>
  );
}

/**
 * Discussion under a technical document. Threads anchored to a passage lead
 * with the passage; page-level threads stand on their own. Resolved threads
 * stay visible but recede, because a settled question is still a record of
 * why the page reads the way it does.
 */
export function Discussion({
  pageId,
  spaceSlug,
  pageSlug,
  user,
  liveBlockIds,
}: {
  pageId: string;
  spaceSlug: string;
  pageSlug: string;
  user: User | null;
  /** Ids of blocks still on the page, so removed anchors can say so. */
  liveBlockIds?: Set<string>;
}) {
  const threads = listThreads(pageId);
  const people = mentionableUsers();
  const open = threads.filter((t) => !t.root.resolved);
  const settled = threads.filter((t) => t.root.resolved);
  const total = threads.reduce((n, t) => n + 1 + t.replies.length, 0);

  const view = (t: Thread) => (
    <ThreadView
      key={t.root.id}
      t={t}
      user={user}
      spaceSlug={spaceSlug}
      pageSlug={pageSlug}
      pageId={pageId}
      live={!t.root.block_id || (liveBlockIds?.has(t.root.block_id) ?? true)}
      people={people}
    />
  );

  return (
    <section
      id="discussion"
      className="mt-14 border-t border-line pt-8 print:hidden"
    >
      <p className="mb-5 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
        Discussion
        {total > 0 && <span className="ml-2 font-mono text-faint">{total}</span>}
      </p>

      {threads.length === 0 && (
        <p className="text-sm text-faint">
          Nothing in the margins yet.
          {!user && " Sign in to leave the first note."}
        </p>
      )}

      {open.length > 0 && <ul className="space-y-3">{open.map(view)}</ul>}

      {settled.length > 0 && (
        <details className="mt-4" open={open.length === 0}>
          <summary className="cursor-pointer list-none text-xs text-faint hover:text-accent">
            {settled.length} resolved{" "}
            {settled.length === 1 ? "thread" : "threads"}
          </summary>
          <ul className="mt-3 space-y-3">{settled.map(view)}</ul>
        </details>
      )}

      {user ? (
        <form action={addCommentAction} className="mt-6">
          <input type="hidden" name="pageId" value={pageId} />
          <input type="hidden" name="space" value={spaceSlug} />
          <CommentBox
            name="body"
            rows={3}
            placeholder="Add to the discussion… use @ to mention someone"
            className="w-full resize-y rounded-lg border border-line bg-surface px-3 py-2.5 text-sm leading-relaxed text-ink outline-none transition-colors placeholder:text-faint focus:border-accent"
          />
          <div className="mt-2 flex justify-end">
            <button className="h-8 rounded-md bg-accent px-3.5 text-xs font-medium text-accent-ink shadow-card transition-transform hover:-translate-y-px">
              Post comment
            </button>
          </div>
        </form>
      ) : (
        threads.length > 0 && (
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
