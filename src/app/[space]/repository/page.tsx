import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { GitBranch, TriangleAlert } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { getSpaceBySlug } from "@/lib/data";
import { canAdminSpace } from "@/lib/roles";
import { getRepoSettings } from "@/lib/repo-sync";
import { runRepoSyncAction, saveRepoAction } from "@/app/actions";
import { SiteHeader } from "@/components/SiteHeader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Repository" };

export default async function SpaceRepository({
  params,
  searchParams,
}: {
  params: Promise<{ space: string }>;
  searchParams: Promise<{
    done?: string; error?: string; synced?: string; p?: string; u?: string; c?: string;
  }>;
}) {
  const { space: slug } = await params;
  const { done, error, synced, p, u, c } = await searchParams;
  const space = getSpaceBySlug(slug);
  if (!space) notFound();
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!canAdminSpace(user, space.id)) redirect(`/${space.slug}`);

  const repo = getRepoSettings(space.id);
  const field =
    "h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none placeholder:text-faint focus:border-accent";
  const label =
    "mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint";

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main id="main" className="mx-auto w-full min-w-0 max-w-3xl flex-1 px-4 py-10 sm:px-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
          Repository
        </p>
        <h1 className="wordmark mt-1 text-[2rem] leading-[1.15] text-ink">
          {space.name}
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
          Keep this space and a branch in agreement. Octavo reads and writes
          through the host&rsquo;s own API — it does not clone, run Git, or need
          anything installed beside it. Pages are pushed as one commit, and
          changes made in the repository come back as pages.
        </p>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          When both sides changed the same page,{" "}
          <strong className="font-medium text-ink">neither is touched</strong>{" "}
          and the pair is reported. Nothing here deletes a page or a file.
        </p>

        {done && (
          <p className="mt-6 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
            Saved.
          </p>
        )}
        {synced && (
          <p className="mt-6 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
            {p ?? 0} pushed, {u ?? 0} pulled
            {Number(c ?? 0) > 0 ? `, ${c} left alone in conflict` : ""}.
          </p>
        )}
        {error && (
          <p className="mt-6 flex items-start gap-2 rounded-lg border border-line bg-bg px-3 py-2 text-sm text-ink">
            <TriangleAlert size={15} className="mt-0.5 shrink-0 text-accent" />
            <span>{error}</span>
          </p>
        )}

        <form action={saveRepoAction} className="mt-8 max-w-2xl space-y-4">
          <input type="hidden" name="space" value={space.slug} />
          <div className="flex gap-3">
            <label className="block w-44">
              <span className={label}>Host</span>
              <select name="provider" defaultValue={repo?.provider ?? "github"} className={field}>
                <option value="github">GitHub</option>
                <option value="gitlab">GitLab</option>
              </select>
            </label>
            <label className="block flex-1">
              <span className={label}>Repository</span>
              <input
                name="repo"
                defaultValue={repo?.repo ?? ""}
                placeholder="owner/name"
                className={`${field} font-mono text-xs`}
              />
            </label>
          </div>

          <label className="block">
            <span className={label}>API endpoint</span>
            <input
              name="endpoint"
              defaultValue={repo?.endpoint ?? ""}
              placeholder="blank for github.com — otherwise https://git.example.org"
              className={`${field} font-mono text-xs`}
            />
            <span className="mt-1 block text-xs text-faint">
              Only needed for a self-hosted GitHub Enterprise or GitLab.
            </span>
          </label>

          <div className="flex gap-3">
            <label className="block flex-1">
              <span className={label}>Branch</span>
              <input
                name="branch"
                defaultValue={repo?.branch ?? "main"}
                placeholder="main"
                className={`${field} font-mono text-xs`}
              />
            </label>
            <label className="block flex-1">
              <span className={label}>Directory</span>
              <input
                name="path"
                defaultValue={repo?.path ?? ""}
                placeholder="docs (blank for the whole repository)"
                className={`${field} font-mono text-xs`}
              />
            </label>
          </div>

          <label className="block">
            <span className={label}>Access token</span>
            <input
              name="token"
              type="password"
              placeholder={repo ? "unchanged — leave blank to keep it" : "a token that can read and write contents"}
              className={`${field} font-mono text-xs`}
            />
            <span className="mt-1 block text-xs text-faint">
              Encrypted at rest and never shown back. It needs permission to
              read and write repository contents, and nothing else. Saving
              checks it against the branch straight away.
            </span>
          </label>

          <button className="h-9 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink">
            {repo ? "Save" : "Connect"}
          </button>
        </form>

        {repo && (
          <>
            <div className="mt-10 rounded-xl border border-line p-4">
              <p className="flex items-center gap-2 text-sm text-ink">
                <GitBranch size={15} className="text-accent" />
                <span className="font-mono text-xs">
                  {repo.repo} · {repo.branch}
                  {repo.path ? ` · ${repo.path}/` : ""}
                </span>
              </p>
              <p className="mt-2 text-xs text-faint">
                {repo.lastSynced
                  ? `Last synced ${new Date(repo.lastSynced).toLocaleString("en-GB")} — ${repo.lastResult}`
                  : "Not synced yet."}
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <form action={runRepoSyncAction}>
                  <input type="hidden" name="space" value={space.slug} />
                  <button className="h-9 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink">
                    Sync now
                  </button>
                </form>
                <form action={saveRepoAction}>
                  <input type="hidden" name="space" value={space.slug} />
                  <input type="hidden" name="disconnect" value="1" />
                  <button className="h-9 rounded-lg border border-line px-4 text-sm text-muted hover:text-ink">
                    Disconnect
                  </button>
                </form>
              </div>
            </div>
          </>
        )}

        <p className="mt-8 text-sm text-muted">
          <Link href={`/${space.slug}/sync`} className="text-accent hover:underline">
            Syncing to a directory instead
          </Link>{" "}
          works the same way, against a folder on disk.
        </p>
      </main>
    </div>
  );
}
