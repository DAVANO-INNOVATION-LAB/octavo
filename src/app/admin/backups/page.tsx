import { redirect } from "next/navigation";
import { Database, Download } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { listSpaces } from "@/lib/data";
import { AdminShell } from "@/components/AdminShell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Backups" };

export default async function AdminBackups() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");
  const spaces = listSpaces(true);

  return (
    <AdminShell active="/admin/backups">
      <section className="rounded-2xl border border-line bg-surface p-6 shadow-card">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Database size={15} className="text-accent" />
          Whole-library backup
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Everything — spaces, pages, versions, comments, users, search index —
          lives in one SQLite file. This downloads a consistent snapshot taken
          with SQLite’s own backup mechanism, safe while the site is running.
          Uploaded files live beside the database in <code className="rounded bg-surface-2 px-1">/data/uploads</code>;
          include that directory in volume snapshots.
        </p>
        <a
          href="/api/admin/backup"
          className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink shadow-card transition-transform hover:-translate-y-px"
        >
          <Download size={14} />
          Download database snapshot
        </a>
      </section>

      <section className="mt-6">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">
          Per-space exports (Markdown + lossless manifest)
        </p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {spaces.map((s) => (
            <li key={s.id}>
              <a
                href={`/api/spaces/${s.slug}/export`}
                className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3.5 py-2.5 text-sm text-ink shadow-card transition-colors hover:border-line-strong"
              >
                <Download size={13} className="shrink-0 text-faint" />
                <span className="min-w-0 truncate">{s.name}</span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-faint">
                  .zip
                </span>
              </a>
            </li>
          ))}
        </ul>
      </section>
    </AdminShell>
  );
}
