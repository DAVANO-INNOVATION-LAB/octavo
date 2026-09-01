import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Eye, EyeOff, PenLine, Repeat2 } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { canEditSpace, canReadSpace } from "@/lib/roles";
import { getPageBySlug, getSpaceBySlug } from "@/lib/data";
import {
  readingEnabled,
  readingReport,
  isRankable,
  MIN_VIEWS,
} from "@/lib/reading";
import { SiteHeader } from "@/components/SiteHeader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Where readers stumble" };

/** A quiet bar. Colour carries the reading, width carries the strength. */
function Bar({ score, enough }: { score: number; enough: boolean }) {
  const pct = Math.round(score * 100);
  return (
    <span
      aria-hidden
      className="relative block h-1.5 w-full overflow-hidden rounded-full bg-wash"
    >
      <span
        className={`absolute inset-y-0 left-0 rounded-full ${
          !enough
            ? "bg-line-strong"
            : score >= 0.55
              ? "bg-[var(--snag)]"
              : score >= 0.3
                ? "bg-accent"
                : "bg-line-strong"
        }`}
        style={{ width: `${Math.max(pct, 2)}%` }}
      />
    </span>
  );
}

function secs(ms: number): string {
  if (ms < 1000) return "<1s";
  return ms < 60_000
    ? `${Math.round(ms / 1000)}s`
    : `${Math.round(ms / 6000) / 10}m`;
}

export default async function ReadingPage({
  params,
}: {
  params: Promise<{ space: string; page: string }>;
}) {
  const { space: spaceSlug, page: pageSlug } = await params;
  const space = getSpaceBySlug(spaceSlug);
  if (!space) notFound();
  const user = await currentUser();
  if (!canReadSpace(user, space)) redirect(user ? "/" : "/login");
  const page = getPageBySlug(space.id, pageSlug);
  if (!page) notFound();
  // What readers found hard is the writer's business. It is not a metric for
  // anyone else, and there is nothing here a reader would want shown around.
  if (!canEditSpace(user, space.id)) redirect(`/${space.slug}/${page.slug}`);

  const on = readingEnabled();
  const passages = readingReport(page.id, page.content);
  const measured = passages.filter((p) => p.views > 0);
  const ranked = [...passages]
    .filter((p) => p.enough && isRankable(p.text))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const totalViews = measured.reduce((n, p) => n + p.views, 0);

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main id="main" className="mx-auto w-full min-w-0 max-w-3xl flex-1 px-4 py-10 sm:px-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
          Where readers stumble
        </p>
        <h1 className="wordmark mt-2 text-[2rem] leading-tight text-ink">
          {page.title}
        </h1>
        <p className="mt-2 max-w-prose text-sm text-muted">
          You wrote this, so you cannot tell which sentence is hard. This is
          where readers slowed down, scrolled back, or stopped.{" "}
          <Link href={`/${space.slug}/${page.slug}`} className="underline">
            Back to the page
          </Link>
        </p>

        <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-faint">
          {on ? <Eye size={14} className="mt-0.5 shrink-0" /> : <EyeOff size={14} className="mt-0.5 shrink-0" />}
          <span>
            {on
              ? "Counted per passage, never per person — the table has no column for who. Readers who send Global Privacy Control are not measured."
              : "Reading signals are switched off for this instance. Nothing is being counted."}
          </span>
        </p>

        {measured.length === 0 ? (
          <p className="mt-10 rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-faint">
            Nothing recorded yet. Signals arrive after people read the
            published page.
          </p>
        ) : (
          <>
            {ranked.length > 0 && (
              <section className="mt-9">
                <h2 className="text-[13px] font-semibold text-ink">
                  The passages to look at first
                </h2>
                <ol className="mt-3 space-y-3">
                  {ranked.map((p, n) => (
                    <li
                      key={p.blockId}
                      className="rounded-xl border border-line p-4"
                    >
                      <div className="flex items-baseline gap-3">
                        <span className="text-xs font-semibold text-faint">
                          {n + 1}
                        </span>
                        <p className="min-w-0 flex-1 text-[15px] leading-relaxed text-ink">
                          {p.text.length > 220
                            ? `${p.text.slice(0, 220)}…`
                            : p.text}
                        </p>
                      </div>
                      <div className="mt-3 pl-6">
                        <Bar score={p.score} enough={p.enough} />
                        <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-faint">
                          <span className="inline-flex items-center gap-1">
                            <Repeat2 size={13} />
                            {Math.round(p.revisitRate * 100)}% scrolled back
                          </span>
                          <span>
                            {secs(p.dwellPerView)} on screen, {secs(p.expectedMs)}{" "}
                            to read
                          </span>
                          {p.exitRate > 0 && (
                            <span>
                              {Math.round(p.exitRate * 100)}% stopped here
                            </span>
                          )}
                          <span>{p.views} readers</span>
                        </p>
                        <Link
                          href={`/${space.slug}/${page.slug}/edit#blk-${p.blockId}`}
                          className="mt-3 inline-flex items-center gap-1.5 text-xs text-accent no-underline hover:underline"
                        >
                          <PenLine size={13} />
                          Rewrite this passage
                        </Link>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            <section className="mt-10">
              <h2 className="text-[13px] font-semibold text-ink">
                The whole page, in order
              </h2>
              <p className="mt-1 text-xs text-faint">
                {totalViews} passage views. Grey means too few readers to say
                anything yet — under {MIN_VIEWS} is noise.
              </p>
              <ul className="mt-4 space-y-2.5">
                {passages.map((p) => (
                  <li key={p.blockId} className="flex items-center gap-3">
                    <span className="w-24 shrink-0 sm:w-32">
                      <Bar score={p.score} enough={p.enough} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-muted">
                      {p.text}
                    </span>
                    <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-faint">
                      {p.views || "—"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
