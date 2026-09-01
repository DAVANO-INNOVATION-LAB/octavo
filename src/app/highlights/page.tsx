import Link from "next/link";
import { redirect } from "next/navigation";
import { Highlighter } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { SiteHeader } from "@/components/SiteHeader";

export const dynamic = "force-dynamic";
export const metadata = { title: "My highlights" };

type Row = {
  id: string;
  text: string;
  note: string;
  created_at: number;
  page_title: string;
  page_slug: string;
  space_slug: string;
  space_name: string;
  block_id: string;
};

/**
 * Everything you marked, across the library, newest first. Yours alone —
 * the query is scoped to the signed-in reader and there is no other view.
 */
export default async function MyHighlights() {
  const user = await currentUser();
  if (!user) redirect("/login");

  const rows = getDb()
    .prepare(
      `SELECT h.id, h.text, h.note, h.created_at, h.block_id,
              p.title AS page_title, p.slug AS page_slug,
              s.slug AS space_slug, s.name AS space_name
         FROM highlights h
         JOIN pages p ON p.id = h.page_id
         JOIN spaces s ON s.id = p.space_id
        WHERE h.user_id = ?
        ORDER BY h.created_at DESC`
    )
    .all(user.id) as Row[];

  // Group by page, keeping page order by most recent mark.
  const groups: { key: string; rows: Row[] }[] = [];
  for (const r of rows) {
    const key = `${r.space_slug}/${r.page_slug}`;
    const g = groups.find((g) => g.key === key);
    if (g) g.rows.push(r);
    else groups.push({ key, rows: [r] });
  }

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main id="main" className="mx-auto w-full min-w-0 max-w-3xl flex-1 px-4 py-10 sm:px-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
          My highlights
        </p>
        <h1 className="wordmark mt-2 text-[2rem] leading-tight text-ink">
          What you marked
        </h1>
        <p className="mt-2 max-w-prose text-sm text-muted">
          Select any passage while reading and press Highlight. It stays
          painted for you on every visit; click a highlight on the page to
          remove it. Nobody else sees your marks.
        </p>

        {groups.length === 0 ? (
          <p className="mt-10 flex items-center justify-center gap-2 rounded-xl border border-dashed border-line px-4 py-8 text-sm text-faint">
            <Highlighter size={15} />
            Nothing marked yet.
          </p>
        ) : (
          <div className="mt-8 space-y-8">
            {groups.map((g) => {
              const first = g.rows[0];
              return (
                <section key={g.key}>
                  <h2 className="text-[13px] font-semibold text-ink">
                    <Link
                      href={`/${first.space_slug}/${first.page_slug}`}
                      className="no-underline hover:text-accent"
                    >
                      {first.page_title}
                    </Link>{" "}
                    <span className="font-normal text-faint">
                      · {first.space_name}
                    </span>
                  </h2>
                  <ul className="mt-3 space-y-2">
                    {g.rows.map((r) => (
                      <li key={r.id}>
                        <Link
                          href={`/${r.space_slug}/${r.page_slug}#blk-${r.block_id}`}
                          className="block rounded-lg border-l-2 border-accent bg-surface px-4 py-2.5 text-sm leading-relaxed text-muted no-underline shadow-card transition-colors hover:text-ink"
                        >
                          {r.text.length > 240 ? `${r.text.slice(0, 240)}…` : r.text}
                          <span className="mt-1 block text-[11px] text-faint">
                            {new Date(r.created_at).toLocaleDateString()}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
