import { redirect } from "next/navigation";
import { Trash2, Zap } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { listSpaces } from "@/lib/data";
import { listConnectors } from "@/lib/connectors";
import { createConnectorAction, deleteConnectorAction } from "@/app/actions";
import { AdminShell } from "@/components/AdminShell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Connectors" };

const TYPE_HINT: Record<string, string> = {
  webhook: "Signed JSON POST to any endpoint — the universal connector.",
  airflow: "Triggers a DAG run; the block's first line is `# dag: my_dag_id`.",
  github_actions: "workflow_dispatch on a workflow file URL.",
};

export default async function AdminConnectors({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");
  const { saved } = await searchParams;
  const connectors = listConnectors();
  const spaces = listSpaces("all");

  return (
    <AdminShell active="/admin/connectors">
      {saved && (
        <p className="mb-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
          Connector saved. Code blocks in its space now carry a Run button.
        </p>
      )}
      <p className="mb-6 text-sm leading-relaxed text-muted">
        A connector lets a cookbook’s code block be executed by a system that
        already holds the credentials and enforces its own access control —
        Octavo never runs anything itself. Runs dispatch only the saved,
        published block content, only to a connector scoped to that page’s
        space, and every run is logged on the page with who ran it and when.
        Credentials are encrypted at rest.
      </p>

      <ul className="space-y-2">
        {connectors.map((c) => (
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
              <span className="block text-[11px] text-faint">
                {c.space_id
                  ? `scoped to ${spaces.find((s) => s.id === c.space_id)?.name ?? "a space"}`
                  : "available to every space"}
              </span>
            </span>
            <form action={deleteConnectorAction}>
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
        {connectors.length === 0 && (
          <li className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-faint">
            No connectors yet — cookbook code blocks stay read-only.
          </li>
        )}
      </ul>

      <form
        action={createConnectorAction}
        className="mt-8 space-y-4 rounded-2xl border border-line bg-surface p-6 shadow-card"
      >
        <h2 className="text-sm font-semibold text-ink">Add a connector</h2>
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
            placeholder="https://airflow.internal — or a webhook receiver URL"
            className="h-10 w-full rounded-lg border border-line bg-bg px-3 font-mono text-sm text-ink outline-none focus:border-accent"
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
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
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
              Scope
            </span>
            <select
              name="space"
              className="h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none focus:border-accent"
            >
              <option value="">Every space (instance-wide)</option>
              {spaces.map((s) => (
                <option key={s.id} value={s.slug}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="text-xs leading-relaxed text-faint">
          {Object.entries(TYPE_HINT).map(([k, v]) => (
            <span key={k} className="block">
              <span className="font-mono">{k}</span> — {v}
            </span>
          ))}
        </p>
        <button className="h-10 w-full rounded-lg bg-accent text-sm font-medium text-accent-ink shadow-card transition-transform hover:-translate-y-px">
          Add connector
        </button>
      </form>
    </AdminShell>
  );
}
