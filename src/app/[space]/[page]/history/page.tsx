import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, History } from "lucide-react";
import { currentUser } from "@/lib/auth";
import {
  getPageBySlug,
  getSpaceBySlug,
  listVersions,
  pageTree,
} from "@/lib/data";
import { SpaceShell } from "@/components/SpaceShell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Page history" };

function when(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function HistoryPage({
  params,
}: {
  params: Promise<{ space: string; page: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { space: spaceSlug, page: pageSlug } = await params;
  const space = getSpaceBySlug(spaceSlug);
  if (!space) notFound();
  const page = getPageBySlug(space.id, pageSlug);
  if (!page) notFound();

  const versions = listVersions(page.id);
  const tree = pageTree(space.id, false);
  const words = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);
  const currentWords = words(page.content_text);

  return (
    <SpaceShell space={space} tree={tree} activeId={page.id} editing rail={null}>
      <div className="mx-auto max-w-2xl">
        <Link
          href={`/${space.slug}/${page.slug}`}
          className="mb-6 inline-flex items-center gap-1.5 text-xs font-medium text-muted transition-colors hover:text-ink"
        >
          <ArrowLeft size={13} />
          Back to the page
        </Link>
        <h1 className="wordmark flex items-center gap-2.5 text-2xl text-ink">
          <History size={20} className="text-faint" />
          History — {page.title}
        </h1>
        <p className="mt-1 text-sm text-muted">
          A version is kept at most every ten minutes of editing, fifty per
          page. Restoring never destroys anything — the current state is
          versioned first.
        </p>

        {versions.length === 0 ? (
          <p className="mt-10 text-sm text-faint">
            No earlier versions yet — history begins with the next edit.
          </p>
        ) : (
          <ol className="mt-8 space-y-2">
            <li className="flex items-baseline gap-4 rounded-lg border border-accent/40 bg-accent-soft px-4 py-3">
              <span className="text-sm font-medium text-accent">Current</span>
              <span className="text-xs text-muted">
                {currentWords} words · updated {when(page.updated_at)}
              </span>
            </li>
            {versions.map((v, i) => {
              const prevWords = words(v.content_text);
              const nextWords =
                i === 0 ? currentWords : words(versions[i - 1].content_text);
              const delta = nextWords - prevWords;
              return (
                <li
                  key={v.id}
                  className="flex items-baseline gap-4 rounded-lg border border-line bg-surface px-4 py-3"
                >
                  <span className="shrink-0 text-sm text-ink">{when(v.saved_at)}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted">
                    {v.title} · {prevWords} words
                    {delta !== 0 && (
                      <span className={delta > 0 ? "text-accent" : "text-faint"}>
                        {" "}
                        ({delta > 0 ? "+" : ""}
                        {delta} after)
                      </span>
                    )}
                  </span>
                  <Link
                    href={`/${space.slug}/${page.slug}/history/${v.id}`}
                    className="shrink-0 text-xs font-medium text-muted underline-offset-2 hover:text-ink hover:underline"
                  >
                    View
                  </Link>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </SpaceShell>
  );
}
