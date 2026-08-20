import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Check, GitMerge, RefreshCw, TriangleAlert, X } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { getPage, getSpaceBySlug } from "@/lib/data";
import { parseBlocks } from "@/lib/blocks";
import { blocksToMarkdown } from "@/lib/markdown";
import { collapseUnchanged, diffLines, diffStat } from "@/lib/diff";
import {
  getChangeRequest,
  listReviews,
  mergeCheck,
} from "@/lib/change-requests";
import {
  mergeChangeRequestAction,
  rebaseChangeRequestAction,
  reviewChangeRequestAction,
  setChangeRequestStatusAction,
} from "@/app/actions";
import { SiteHeader } from "@/components/SiteHeader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Change request" };

export default async function ChangeRequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ space: string; page: string; cr: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { space: spaceSlug, page: pageSlug, cr: crId } = await params;
  const { error } = await searchParams;
  const space = getSpaceBySlug(spaceSlug);
  if (!space) notFound();
  const user = await currentUser();
  if (space.visibility === "private" && !user) redirect("/login");

  const cr = getChangeRequest(crId);
  if (!cr) notFound();
  const page = getPage(cr.page_id);
  if (!page) notFound();

  // Diff the writing, not the storage: both sides render to Markdown first.
  const currentMd = blocksToMarkdown(parseBlocks(page.content));
  const proposedMd = blocksToMarkdown(parseBlocks(cr.proposed_content));
  const rows = diffLines(currentMd, proposedMd);
  const stat = diffStat(rows);
  const groups = collapseUnchanged(rows);

  const reviews = listReviews(cr.id);
  const check = mergeCheck(cr);
  const titleChanged = page.title !== cr.proposed_title;
  const mine = user?.id === cr.author_id;

  const hidden = (
    <>
      <input type="hidden" name="id" value={cr.id} />
      <input type="hidden" name="space" value={space.slug} />
      <input type="hidden" name="page" value={page.slug} />
    </>
  );

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="mx-auto w-full min-w-0 max-w-4xl flex-1 px-4 py-10 sm:px-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
          <Link href={`/${space.slug}/${page.slug}/changes`} className="no-underline">
            Change request
          </Link>
        </p>
        <h1 className="wordmark mt-2 text-[2rem] leading-tight text-ink">
          {cr.title}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {cr.author} proposed this for{" "}
          <Link href={`/${space.slug}/${page.slug}`} className="underline">
            {cr.page_title}
          </Link>{" "}
          · <span className="text-[#22a05e]">+{stat.added}</span>{" "}
          <span className="text-[#dc2626]">−{stat.removed}</span> ·{" "}
          <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-faint">
            {cr.status}
          </span>
        </p>

        {cr.description && (
          <p className="mt-4 whitespace-pre-wrap rounded-xl border border-line bg-surface px-4 py-3 text-[15px] leading-relaxed text-ink">
            {cr.description}
          </p>
        )}

        {error === "self" && (
          <p className="mt-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
            You can’t review your own proposal.
          </p>
        )}

        {check.blockers.length > 0 && cr.status === "open" && (
          <div className="mt-5 rounded-xl border border-[rgba(217,119,6,.4)] bg-[rgba(217,119,6,.09)] px-4 py-3">
            <p className="flex items-center gap-2 text-sm font-medium text-ink">
              <TriangleAlert size={15} className="text-[#d97706]" />
              Not ready to merge
            </p>
            <ul className="mt-1.5 space-y-0.5 text-sm text-muted">
              {check.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
            {!check.current && (mine || user?.role === "admin") && (
              <form action={rebaseChangeRequestAction} className="mt-3">
                {hidden}
                <button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-xs text-muted hover:border-accent hover:text-accent">
                  <RefreshCw size={13} />
                  Compare against the page as it stands now
                </button>
              </form>
            )}
          </div>
        )}

        {titleChanged && (
          <p className="mt-5 text-sm text-muted">
            Title: <span className="line-through text-faint">{page.title}</span>{" "}
            → <span className="text-ink">{cr.proposed_title}</span>
          </p>
        )}

        <div className="mt-6 overflow-hidden rounded-xl border border-line">
          <div className="flex items-center justify-between border-b border-line bg-surface-2/40 px-4 py-2 text-[11px] uppercase tracking-[0.1em] text-faint">
            <span>Current</span>
            <span>Proposed</span>
          </div>
          {stat.added === 0 && stat.removed === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-faint">
              This proposal makes no changes to the body text.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] border-collapse font-mono text-[12.5px] leading-relaxed">
                <tbody>
                  {groups.map((group, gi) => (
                    <>
                      {gi > 0 && (
                        <tr key={`gap-${gi}`}>
                          <td
                            colSpan={4}
                            className="border-y border-line bg-surface-2/40 px-3 py-1 text-center text-[11px] text-faint"
                          >
                            unchanged lines omitted
                          </td>
                        </tr>
                      )}
                      {group.map((r, i) => (
                        <tr key={`${gi}-${i}`} className="align-top">
                          <td className="w-10 select-none px-2 text-right text-faint">
                            {r.kind !== "add" ? r.aNo : ""}
                          </td>
                          <td
                            className={`w-1/2 whitespace-pre-wrap px-3 py-0.5 ${
                              r.kind === "del"
                                ? "bg-[rgba(220,38,38,.10)] text-ink"
                                : "text-muted"
                            }`}
                          >
                            {r.kind !== "add" ? r.a || " " : ""}
                          </td>
                          <td className="w-10 select-none px-2 text-right text-faint">
                            {r.kind !== "del" ? r.bNo : ""}
                          </td>
                          <td
                            className={`w-1/2 whitespace-pre-wrap px-3 py-0.5 ${
                              r.kind === "add"
                                ? "bg-[rgba(34,160,94,.10)] text-ink"
                                : "text-muted"
                            }`}
                          >
                            {r.kind !== "del" ? r.b || " " : ""}
                          </td>
                        </tr>
                      ))}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <section className="mt-8">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
            Review
            {reviews.length > 0 && (
              <span className="ml-2 font-mono">{reviews.length}</span>
            )}
          </p>

          {reviews.length === 0 && (
            <p className="text-sm text-faint">Nobody has reviewed this yet.</p>
          )}

          <ul className="space-y-3">
            {reviews.map((r) => (
              <li
                key={r.id}
                className="rounded-xl border border-line bg-surface px-4 py-3"
              >
                <p className="text-xs text-faint">
                  <span className="font-medium text-muted">{r.reviewer}</span>
                  <span className="mx-1.5">·</span>
                  <span
                    className={
                      r.verdict === "approve" ? "text-[#22a05e]" : "text-[#d97706]"
                    }
                  >
                    {r.verdict === "approve" ? "approved" : "asked for changes"}
                  </span>
                  <span className="mx-1.5">·</span>
                  {new Date(r.at).toLocaleDateString()}
                </p>
                {r.note && (
                  <p className="mt-1 whitespace-pre-wrap text-[15px] leading-relaxed text-ink">
                    {r.note}
                  </p>
                )}
              </li>
            ))}
          </ul>

          {user && cr.status === "open" && !mine && (
            <form action={reviewChangeRequestAction} className="mt-5">
              {hidden}
              <textarea
                name="note"
                rows={2}
                maxLength={4000}
                placeholder="Leave a note with your review…"
                className="w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-sm leading-relaxed text-ink outline-none placeholder:text-faint focus:border-accent"
              />
              <div className="mt-2 flex flex-wrap justify-end gap-2">
                <button
                  name="verdict"
                  value="changes"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-xs text-muted hover:border-accent hover:text-accent"
                >
                  <X size={13} />
                  Request changes
                </button>
                <button
                  name="verdict"
                  value="approve"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3.5 text-xs font-medium text-accent-ink"
                >
                  <Check size={13} />
                  Approve
                </button>
              </div>
            </form>
          )}

          {user && cr.status === "open" && mine && (
            <p className="mt-4 text-xs text-faint">
              This is your proposal — someone else needs to review it.
            </p>
          )}
        </section>

        {user && cr.status === "open" && (
          <div className="mt-8 flex flex-wrap items-center gap-2 border-t border-line pt-6">
            <form action={mergeChangeRequestAction}>
              {hidden}
              <button
                disabled={check.blockers.length > 0}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-4 text-sm font-medium text-accent-ink disabled:opacity-40"
              >
                <GitMerge size={14} />
                Merge into the page
              </button>
            </form>
            {(mine || user.role === "admin") && (
              <form action={setChangeRequestStatusAction}>
                {hidden}
                <input type="hidden" name="status" value="closed" />
                <button className="h-9 rounded-md border border-line px-3.5 text-sm text-muted hover:border-accent hover:text-accent">
                  Close without merging
                </button>
              </form>
            )}
          </div>
        )}

        {cr.status === "merged" && (
          <p className="mt-8 border-t border-line pt-6 text-sm text-muted">
            Merged{cr.merged_at ? ` on ${new Date(cr.merged_at).toLocaleDateString()}` : ""}.
            The page now carries these changes.
          </p>
        )}
      </main>
    </div>
  );
}
