import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { FolderSync, TriangleAlert } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { getSpaceBySlug } from "@/lib/data";
import { canAdminSpace } from "@/lib/roles";
import { planFor, syncRoot } from "@/lib/sync-io";
import { summarize } from "@/lib/sync";
import { runSyncAction } from "@/app/actions";
import { SiteHeader } from "@/components/SiteHeader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sync" };

export default async function SpaceSync({
  params,
  searchParams,
}: {
  params: Promise<{ space: string }>;
  searchParams: Promise<{ done?: string; w?: string; i?: string; c?: string }>;
}) {
  const { space: slug } = await params;
  const { done, w, i, c } = await searchParams;
  const space = getSpaceBySlug(slug);
  if (!space) notFound();
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!canAdminSpace(user, space.id)) redirect(`/${space.slug}`);

  const plan = planFor(space);
  const counts = summarize(plan);
  const conflicts = plan.actions.filter((a) => a.kind === "conflict");
  const orphans = plan.actions.filter((a) => a.kind === "orphan-page");

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="mx-auto w-full min-w-0 max-w-3xl flex-1 px-4 py-10 sm:px-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
          Sync
        </p>
        <h1 className="wordmark mt-2 text-[2rem] leading-tight text-ink">
          {space.name}
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
          This space mirrors to a directory of Markdown files. Point that
          directory at a Git working tree and commit it with whatever already
          holds your credentials — a sidecar, a cron entry, a CI job. Octavo
          writes and reads the files; it does not run Git, and does not need
          to.
        </p>
        <p className="mt-2 font-mono text-xs text-faint">{plan.dir}</p>
        <p className="mt-1 text-xs text-faint">
          Set <code className="text-muted">OCTAVO_SYNC_DIR</code> to move the
          root. Default is <code className="text-muted">{syncRoot()}</code>.
        </p>

        {done && (
          <p className="mt-5 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
            Wrote {w ?? 0}, imported {i ?? 0}
            {Number(c ?? 0) > 0 ? `, left ${c} conflict(s) alone` : ""}.
          </p>
        )}

        <div className="mt-7 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["To write", counts.write],
            ["To import", counts.import],
            ["Conflicts", counts.conflict],
            ["Unchanged", counts.unchanged],
          ].map(([label, n]) => (
            <div
              key={String(label)}
              className="rounded-xl border border-line bg-surface px-3 py-3"
            >
              <p className="font-mono text-[1.4rem] leading-none text-ink">{n}</p>
              <p className="mt-1.5 text-[11px] uppercase tracking-[0.1em] text-faint">
                {label}
              </p>
            </div>
          ))}
        </div>

        {conflicts.length > 0 && (
          <div className="mt-6 rounded-xl border border-[rgba(217,119,6,.4)] bg-[rgba(217,119,6,.09)] px-4 py-3">
            <p className="flex items-center gap-2 text-sm font-medium text-ink">
              <TriangleAlert size={15} className="text-[#d97706]" />
              {conflicts.length} file{conflicts.length === 1 ? "" : "s"} changed
              on both sides
            </p>
            <p className="mt-1 text-sm text-muted">
              These are left exactly as they are. Reconcile the file and the
              page by hand, then sync again.
            </p>
            <ul className="mt-2 space-y-0.5 font-mono text-xs text-muted">
              {conflicts.map((a) => (
                <li key={a.path}>{a.path}</li>
              ))}
            </ul>
          </div>
        )}

        {orphans.length > 0 && (
          <div className="mt-4 rounded-xl border border-line bg-surface px-4 py-3">
            <p className="text-sm font-medium text-ink">
              {orphans.length} page{orphans.length === 1 ? "" : "s"} whose file
              is gone
            </p>
            <p className="mt-1 text-sm text-muted">
              A missing file is as often a bad checkout as a deliberate
              deletion, so nothing is removed. Delete the page in Octavo if you
              meant to.
            </p>
            <ul className="mt-2 space-y-0.5 font-mono text-xs text-muted">
              {orphans.map((a) => (
                <li key={a.path}>{a.path}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-8 flex items-center gap-3 border-t border-line pt-6">
          <form action={runSyncAction}>
            <input type="hidden" name="space" value={space.slug} />
            <button className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-ink shadow-card transition-transform hover:-translate-y-px">
              <FolderSync size={15} />
              Sync now
            </button>
          </form>
          <Link href={`/${space.slug}`} className="text-sm text-muted underline">
            Back to the space
          </Link>
        </div>
      </main>
    </div>
  );
}
