import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { GitPullRequest } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { getPageBySlug, getSpaceBySlug } from "@/lib/data";
import { listChangeRequests } from "@/lib/change-requests";
import { SiteHeader } from "@/components/SiteHeader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Change requests" };

export default async function ChangesList({
  params,
}: {
  params: Promise<{ space: string; page: string }>;
}) {
  const { space: spaceSlug, page: pageSlug } = await params;
  const space = getSpaceBySlug(spaceSlug);
  if (!space) notFound();
  const user = await currentUser();
  if (space.visibility === "private" && !user) redirect("/login");
  const page = getPageBySlug(space.id, pageSlug);
  if (!page) notFound();

  const all = listChangeRequests({ pageId: page.id });
  const open = all.filter((c) => c.status === "open");
  const done = all.filter((c) => c.status !== "open");

  const row = (c: (typeof all)[number]) => (
    <li key={c.id} className="border-b border-line last:border-0">
      <Link
        href={`/${space.slug}/${page.slug}/changes/${c.id}`}
        className="flex items-baseline gap-3 px-4 py-3 no-underline hover:bg-wash"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] text-ink">{c.title}</span>
          <span className="mt-0.5 block text-xs text-faint">
            {c.author} · {new Date(c.created_at).toLocaleDateString()}
          </span>
        </span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${
            c.status === "open"
              ? "bg-accent-soft text-accent"
              : "border border-line text-faint"
          }`}
        >
          {c.status}
        </span>
      </Link>
    </li>
  );

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="mx-auto w-full min-w-0 max-w-3xl flex-1 px-4 py-10 sm:px-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
          Change requests
        </p>
        <h1 className="wordmark mt-2 text-[2rem] leading-tight text-ink">
          {page.title}
        </h1>
        <p className="mt-2 text-sm text-muted">
          Proposed edits waiting on review.{" "}
          <Link href={`/${space.slug}/${page.slug}`} className="underline">
            Back to the page
          </Link>
        </p>

        {all.length === 0 ? (
          <p className="mt-8 flex items-center gap-2 text-sm text-faint">
            <GitPullRequest size={15} />
            Nothing proposed yet. Open the editor and choose “Propose changes”.
          </p>
        ) : (
          <>
            {open.length > 0 && (
              <ul className="mt-8 overflow-hidden rounded-xl border border-line">
                {open.map(row)}
              </ul>
            )}
            {done.length > 0 && (
              <details className="mt-4" open={open.length === 0}>
                <summary className="cursor-pointer list-none text-xs text-faint hover:text-accent">
                  {done.length} closed or merged
                </summary>
                <ul className="mt-3 overflow-hidden rounded-xl border border-line">
                  {done.map(row)}
                </ul>
              </details>
            )}
          </>
        )}
      </main>
    </div>
  );
}
