import Link from "next/link";
import { redirect } from "next/navigation";
import { BookOpen, Plus, Upload } from "lucide-react";
import { currentUser, userCount } from "@/lib/auth";
import { listSpaces, listPages } from "@/lib/data";
import { primaryOnly } from "@/lib/variants";
import { readablePrivateSpaceIds } from "@/lib/roles";
import { SiteHeader } from "@/components/SiteHeader";
import { LibraryGrid, type ShelfSpace } from "@/components/LibraryGrid";

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
  // Variants of one library share a shelf entry; the rest are reached from
  // the switcher, so six translations of a handbook do not fill the shelf.
  const spaces = primaryOnly(listSpaces(readablePrivateSpaceIds(user)));
  const shelf: ShelfSpace[] = spaces.map((s) => ({
    slug: s.slug,
    name: s.name,
    description: s.description,
    kind: s.kind,
    visibility: s.visibility,
    shelf: s.shelf,
    kindLabel: KIND_LABEL[s.kind] ?? s.kind,
    pageCount: listPages(s.id).filter((p) => p.published === 1).length,
    updatedLabel: timeAgo(s.updated_at),
  }));

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
          // The shelf is one arrangement everyone sees, so only the
          // administrator rearranges it — matching the API.
          <LibraryGrid spaces={shelf} editing={user?.role === "admin"} />
        )}
      </main>
    </div>
  );
}
