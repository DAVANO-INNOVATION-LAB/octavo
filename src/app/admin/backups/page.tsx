import { redirect } from "next/navigation";
import { AlertTriangle, Database, Download, Upload } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { listSpaces } from "@/lib/data";
import { AdminShell } from "@/components/AdminShell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Backups" };

export default async function AdminBackups({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; restored?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");
  const { error, restored } = await searchParams;
  const spaces = listSpaces("all");

  return (
    <AdminShell active="/admin/backups">
      {error && (
        <p className="mb-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
          Restore refused: {error}. Nothing was changed.
        </p>
      )}
      {restored && (
        <p className="mb-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
          Snapshot restored. Sign in again with an account from that snapshot;
          the replaced database was kept in /data as octavo-replaced-*.db.
        </p>
      )}
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
        {/* File download from a route handler — a real navigation, not a
            client-side route; <Link> would be wrong here. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/api/admin/backup"
          className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink shadow-card transition-transform hover:-translate-y-px"
        >
          <Download size={14} />
          Download database snapshot
        </a>
      </section>

      <section className="mt-6 rounded-2xl border border-accent/30 bg-surface p-6">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Upload size={15} className="text-accent" />
          Restore a snapshot
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Replaces the entire library — every space, page, version, comment,
          and account — with the contents of a snapshot taken above. The file
          is verified as a genuine Octavo database before anything is touched,
          and the database being replaced is saved beside it in{" "}
          <code className="rounded bg-surface-2 px-1">/data</code> so the
          restore can be undone. You will be signed out.
        </p>
        <p className="mt-3 flex items-start gap-2 text-sm text-accent">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          Uploaded files in <code className="rounded bg-surface-2 px-1">/data/uploads</code>{" "}
          are not part of the database snapshot — restore that directory from
          your volume backup alongside it.
        </p>
        <form
          action="/api/admin/restore"
          method="post"
          encType="multipart/form-data"
          className="mt-4 space-y-3"
        >
          <input
            required
            type="file"
            name="file"
            accept=".db,.sqlite,.sqlite3,application/vnd.sqlite3,application/octet-stream"
            className="block w-full cursor-pointer rounded-lg border border-line bg-bg px-3 py-2 text-sm text-muted file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-accent file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-accent-ink"
          />
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              required
              name="confirm"
              pattern="REPLACE"
              placeholder="Type REPLACE to confirm"
              className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none focus:border-accent"
            />
            <button className="h-10 shrink-0 rounded-lg border border-accent/40 px-4 text-sm font-medium text-accent transition-colors hover:bg-accent hover:text-accent-ink">
              Restore this snapshot
            </button>
          </div>
        </form>
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
