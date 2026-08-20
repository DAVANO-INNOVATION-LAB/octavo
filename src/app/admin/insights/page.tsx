import Link from "next/link";
import { redirect } from "next/navigation";
import { Eye, Search, ThumbsDown, Clock } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { pageInsights, searchInsights } from "@/lib/data";
import { AdminShell } from "@/components/AdminShell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Insights" };

function ago(ts: number) {
  const d = Math.floor((Date.now() - ts) / 86400_000);
  if (d < 1) return "today";
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

function List({
  title,
  icon,
  empty,
  rows,
}: {
  title: string;
  icon: React.ReactNode;
  empty: string;
  rows: { href: string; label: string; sub: string; right: string }[];
}) {
  return (
    <section className="min-w-0">
      <p className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">
        {icon}
        {title}
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-faint">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r, i) => (
            <li key={i} className="flex min-w-0 items-baseline gap-2 text-sm">
              <Link href={r.href} className="min-w-0 truncate text-ink hover:text-accent">
                {r.label}
              </Link>
              <span className="ml-auto shrink-0 font-mono text-xs text-faint">
                {r.right}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default async function AdminInsights() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");

  const p = pageInsights(30);
  const s = searchInsights(30);
  const row = (x: (typeof p.mostRead)[number], right: string) => ({
    href: `/${x.space_slug}/${x.page_slug}`,
    label: x.title,
    sub: x.space_name,
    right,
  });

  return (
    <AdminShell active="/admin/insights">
      <p className="mb-6 text-sm leading-relaxed text-muted">
        The last 30 days. Counts are kept locally with no cookies, no
        identifiers, and no third party — they exist to find stale and missing
        pages, not to follow readers. {p.totalViews} page{p.totalViews === 1 ? "" : "s"} read.
      </p>

      <div className="grid gap-8 sm:grid-cols-2 [&>section]:min-w-0">
        <List
          title="Most read"
          icon={<Eye size={13} />}
          empty="No reads recorded yet."
          rows={p.mostRead.map((x) => row(x, `${x.views}`))}
        />
        <List
          title="Read often, not updated in months"
          icon={<Clock size={13} />}
          empty="Nothing has gone stale."
          rows={p.stale.map((x) => row(x, ago(x.updated_at)))}
        />
        <List
          title="Marked unhelpful"
          icon={<ThumbsDown size={13} />}
          empty="No negative feedback."
          rows={p.unhelpful.map((x) => row(x, `${x.unhelpful}`))}
        />
        <List
          title="Never read"
          icon={<Eye size={13} />}
          empty="Every published page has been read."
          rows={p.neverRead.map((x) => row(x, "0"))}
        />
      </div>

      <div className="mt-10 grid gap-8 sm:grid-cols-2">
        <section className="min-w-0">
          <p className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">
            <Search size={13} />
            Top searches
          </p>
          {s.top.length === 0 ? (
            <p className="text-sm text-faint">No searches yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {s.top.map((q) => (
                <li key={q.query} className="flex items-baseline gap-2 text-sm">
                  <span className="min-w-0 truncate text-ink">{q.query}</span>
                  <span className="ml-auto shrink-0 font-mono text-xs text-faint">
                    {q.times}×
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="min-w-0">
          <p className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">
            <Search size={13} />
            Searched for, found nothing
          </p>
          {s.empty.length === 0 ? (
            <p className="text-sm text-faint">
              Every search found something — no obvious gaps.
            </p>
          ) : (
            <>
              <ul className="space-y-1.5">
                {s.empty.map((q) => (
                  <li key={q.query} className="flex items-baseline gap-2 text-sm">
                    <span className="min-w-0 truncate text-accent">{q.query}</span>
                    <span className="ml-auto shrink-0 font-mono text-xs text-faint">
                      {q.times}×
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs leading-relaxed text-faint">
                These are the pages your library is missing.
              </p>
            </>
          )}
        </section>
      </div>
    </AdminShell>
  );
}
