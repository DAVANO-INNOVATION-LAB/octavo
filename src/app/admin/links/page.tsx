import Link from "next/link";
import { redirect } from "next/navigation";
import { LinkIcon, Unlink } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { brokenLinks } from "@/lib/data";
import { AdminShell } from "@/components/AdminShell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Broken links" };

export default async function AdminLinks() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");
  const broken = brokenLinks();

  return (
    <AdminShell active="/admin/links">
      <p className="mb-6 text-sm leading-relaxed text-muted">
        Internal links on published pages that no longer resolve — found before
        a reader finds them. External URLs are left alone; they are not ours to
        judge.
      </p>
      {broken.length === 0 ? (
        <p className="flex items-center gap-2 rounded-xl border border-line bg-surface px-4 py-6 text-sm text-muted shadow-card">
          <LinkIcon size={15} className="text-accent" />
          Every internal link resolves.
        </p>
      ) : (
        <ul className="space-y-2">
          {broken.map((b, i) => (
            <li
              key={`${b.page_id}-${b.href}-${i}`}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-card"
            >
              <Unlink size={15} className="shrink-0 text-accent" />
              <span className="min-w-0 flex-1">
                <Link
                  href={`/${b.space_slug}/${b.page_slug}`}
                  className="block truncate text-sm font-medium text-ink hover:text-accent"
                >
                  {b.page_title}
                </Link>
                <span className="block truncate font-mono text-xs text-muted">
                  {b.href}
                </span>
                <span className="block text-[11px] text-faint">
                  {b.reason} · in {b.space_name}
                </span>
              </span>
              <Link
                href={`/${b.space_slug}/${b.page_slug}/edit`}
                className="h-8 shrink-0 rounded-md border border-line bg-bg px-2.5 text-xs font-medium leading-8 text-muted transition-colors hover:text-ink"
              >
                Fix
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AdminShell>
  );
}
