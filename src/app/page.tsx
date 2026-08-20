import Link from "next/link";
import { redirect } from "next/navigation";
import { BookOpen, Lock, Plus, Upload } from "lucide-react";
import { currentUser, userCount } from "@/lib/auth";
import { listSpaces, listPages } from "@/lib/data";
import { SiteHeader } from "@/components/SiteHeader";
import { Monogram } from "@/components/Monogram";
import { SiteFooter } from "@/components/SiteFooter";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  docs: "Documentation",
  cookbook: "Cookbook",
  articles: "Articles",
  wiki: "Wiki",
};

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

export default async function Home() {
  if (userCount() === 0) redirect("/setup");
  const user = await currentUser();
  const spaces = listSpaces(Boolean(user));

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-10 sm:px-6">
        <div className="mb-8 flex items-end justify-between gap-4">
          <div>
            <h1 className="wordmark text-3xl text-ink">The library</h1>
            <p className="mt-1 text-sm text-muted">
              {spaces.length === 0
                ? "Nothing on the shelves yet."
                : `${spaces.length} ${spaces.length === 1 ? "space" : "spaces"} on the shelf`}
            </p>
          </div>
          {user && (
            <div className="flex shrink-0 items-center gap-2">
              <Link
                href="/import"
                className="flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 text-sm font-medium text-muted shadow-card transition-colors hover:border-line-strong hover:text-ink"
              >
                <Upload size={14} />
                Import
              </Link>
              <Link
                href="/new"
                className="flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-sm font-medium text-accent-ink shadow-card transition-transform hover:-translate-y-px"
              >
                <Plus size={15} />
                New space
              </Link>
            </div>
          )}
        </div>

        {spaces.length === 0 ? (
          <div className="rise mx-auto mt-16 max-w-md rounded-2xl border border-line bg-surface p-10 text-center shadow-card">
            <BookOpen className="mx-auto mb-4 text-faint" size={32} />
            <h2 className="wordmark text-xl text-ink">Bind your first book</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              A space is a book on this shelf — product docs, a runbook
              cookbook, a collection of essays. Beautiful to write, beautiful
              to read.
            </p>
            {user ? (
              <Link
                href="/new"
                className="mt-6 inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink"
              >
                <Plus size={15} />
                Create a space
              </Link>
            ) : (
              <Link
                href="/login"
                className="mt-6 inline-flex h-9 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink"
              >
                Sign in to start writing
              </Link>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {spaces.map((s, i) => {
              const pages = listPages(s.id).filter((p) => p.published === 1);
              return (
                <Link
                  key={s.id}
                  href={`/${s.slug}`}
                  className="rise group relative overflow-hidden rounded-xl border border-line bg-surface p-6 pl-7 shadow-card transition-all hover:-translate-y-0.5 hover:shadow-pop"
                  style={{ animationDelay: `${i * 40}ms` }}
                >
                  <span className="absolute inset-y-0 left-0 w-1.5 bg-accent/80 transition-all group-hover:w-2" />
                  <Monogram name={s.name} />
                  <h2 className="wordmark mt-3 flex items-center gap-2 text-xl leading-snug text-ink">
                    {s.name}
                    {s.visibility === "private" && (
                      <Lock size={13} className="shrink-0 text-faint" />
                    )}
                  </h2>
                  {s.description && (
                    <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-muted">
                      {s.description}
                    </p>
                  )}
                  <p className="mt-4 text-[11px] font-medium uppercase tracking-[0.1em] text-faint">
                    {KIND_LABEL[s.kind] ?? s.kind} · {pages.length}{" "}
                    {pages.length === 1 ? "page" : "pages"} ·{" "}
                    {timeAgo(s.updated_at)}
                  </p>
                </Link>
              );
            })}
          </div>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
