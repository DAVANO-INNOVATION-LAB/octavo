import { notFound, redirect } from "next/navigation";
import { Trash2, Zap } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { getSpaceBySlug, pageTree } from "@/lib/data";
import { canAdminSpace } from "@/lib/roles";
import { connectorsForSpace } from "@/lib/connectors";
import {
  createSpaceConnectorAction,
  deleteSpaceConnectorAction,
} from "@/app/actions";
import { SpaceShell } from "@/components/SpaceShell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Space connectors" };

export default async function SpaceConnectors({
  params,
  searchParams,
}: {
  params: Promise<{ space: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { space: slug } = await params;
  const { saved } = await searchParams;
  const space = getSpaceBySlug(slug);
  if (!space) notFound();
  if (!canAdminSpace(user, space.id)) redirect(`/${space.slug}`);

  const all = connectorsForSpace(space.id);
  const mine = all.filter((c) => c.space_id === space.id);
  const inherited = all.filter((c) => c.space_id === null);
  const tree = pageTree(space.id, false);

  return (
    <SpaceShell space={space} tree={tree} editing rail={null}>
      <div className="mx-auto max-w-2xl">
        <h1 className="wordmark text-2xl text-ink">Connectors for {space.name}</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          Connectors you add here belong to this space and cannot be used from
          any other. Runs dispatch only the saved, published code block, and
          every run is logged on its page. Credentials are encrypted at rest.
        </p>

        {saved && (
          <p className="mt-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
            Connector saved — code blocks in this space now carry a Run button.
          </p>
        )}

        <ul className="mt-6 space-y-2">
          {mine.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-card"
            >
              <Zap size={15} className="shrink-0 text-accent" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-ink">{c.name}</span>
                <span className="block truncate font-mono text-xs text-muted">
                  {c.type} · {c.base_url}
                </span>
              </span>
              <form action={deleteSpaceConnectorAction}>
                <input type="hidden" name="space" value={space.slug} />
                <input type="hidden" name="id" value={c.id} />
                <button
                  title="Delete connector"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-faint transition-colors hover:bg-accent-soft hover:text-accent"
                >
                  <Trash2 size={14} />
                </button>
              </form>
            </li>
          ))}
          {mine.length === 0 && (
            <li className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-faint">
              This space has no connectors of its own yet.
            </li>
          )}
        </ul>

        {inherited.length > 0 && (
          <div className="mt-6">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">
              Also available here (instance-wide)
            </p>
            <ul className="space-y-1.5">
              {inherited.map((c) => (
                <li key={c.id} className="text-sm text-muted">
                  {c.name}{" "}
                  <span className="font-mono text-xs text-faint">({c.type})</span>
                  <span className="ml-2 text-xs text-faint">
                    — managed by an instance admin
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <form
          action={createSpaceConnectorAction}
          className="mt-8 space-y-4 rounded-2xl border border-line bg-surface p-6 shadow-card"
        >
          <input type="hidden" name="space" value={space.slug} />
          <h2 className="text-sm font-semibold text-ink">
            Add a connector for this space
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
                Name
              </span>
              <input
                required
                name="name"
                placeholder="Staging Airflow"
                className="h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none focus:border-accent"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
                Type
              </span>
              <select
                name="type"
                className="h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none focus:border-accent"
              >
                <option value="webhook">Webhook (any system)</option>
                <option value="airflow">Airflow</option>
                <option value="github_actions">GitHub Actions</option>
              </select>
            </label>
          </div>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
              Endpoint URL
            </span>
            <input
              required
              name="base_url"
              placeholder="https://airflow.internal"
              className="h-10 w-full rounded-lg border border-line bg-bg px-3 font-mono text-sm text-ink outline-none focus:border-accent"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
              Token or signing secret
            </span>
            <input
              name="credential"
              type="password"
              placeholder="encrypted at rest"
              className="h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none focus:border-accent"
            />
          </label>
          <button className="h-10 w-full rounded-lg bg-accent text-sm font-medium text-accent-ink shadow-card transition-transform hover:-translate-y-px">
            Add connector
          </button>
        </form>
      </div>
    </SpaceShell>
  );
}
