import { redirect } from "next/navigation";
import { ShieldCheck, ShieldAlert, Download } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { auditActions, listAudit, verifyChain } from "@/lib/audit";
import { forwardConfig } from "@/lib/audit-forward";
import { saveAuditForwardAction } from "@/app/actions";
import { AdminShell } from "@/components/AdminShell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Audit log" };

function when(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default async function AdminAudit({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; actor?: string; page?: string }>;
}) {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (me.role !== "admin") redirect("/");

  const { action, actor, page } = await searchParams;
  const pageNo = Math.max(1, Number(page ?? "1") || 1);
  const perPage = 100;
  const entries = listAudit({
    action: action || undefined,
    actorId: actor || undefined,
    limit: perPage,
    offset: (pageNo - 1) * perPage,
  });
  const chain = verifyChain();
  const actions = auditActions();
  const fwd = forwardConfig();

  return (
    <AdminShell active="/admin/audit">
      <div
        className={`mb-6 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 ${
          chain.ok
            ? "border-line bg-surface"
            : "border-[rgba(220,38,38,.4)] bg-[rgba(220,38,38,.08)]"
        }`}
      >
        {chain.ok ? (
          <ShieldCheck size={16} className="shrink-0 text-accent" />
        ) : (
          <ShieldAlert size={16} className="shrink-0 text-[#dc2626]" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm text-ink">
            {chain.ok
              ? `The chain verifies across all ${chain.entries} entries.`
              : `The chain breaks at entry ${chain.brokenAt} — ${chain.why}.`}
          </p>
          <p className="mt-0.5 break-all font-mono text-[11px] text-faint">
            head {chain.head}
          </p>
        </div>
        {/* A real navigation: this streams a file rather than rendering a page. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/api/audit/export"
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line px-3 text-xs text-muted transition-colors hover:border-accent hover:text-accent"
        >
          <Download size={13} />
          Export
        </a>
      </div>

      <details className="mb-6 rounded-xl border border-line bg-surface px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium text-ink">
          Forward these events to your own collector
        </summary>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          Keeping the record here answers what happened. It does not tell
          anyone when it happens, and it does not survive this machine. Sending
          events to a collector puts them under your retention and out of reach
          of whoever might compromise this host.
        </p>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          Delivery is best-effort and always after the entry is committed, so a
          collector that is slow or unreachable never delays or fails the action
          being recorded. The collector can be on your own network.
        </p>
        <form action={saveAuditForwardAction} className="mt-4 space-y-3">
          <label className="block">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
              Syslog target
            </span>
            <input
              name="syslog"
              defaultValue={fwd.syslog}
              placeholder="udp://collector.internal:514 — or tcp:// or tls://"
              className="mt-1.5 w-full rounded-lg border border-line bg-bg px-3 py-2 font-mono text-sm text-ink outline-none placeholder:text-faint focus:border-accent"
            />
            <span className="mt-1 block text-xs text-faint">
              RFC 5424, with octet framing on the stream transports.
            </span>
          </label>
          <label className="block">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
              HTTP collector
            </span>
            <input
              name="http"
              type="url"
              defaultValue={fwd.http}
              placeholder="https://splunk.internal:8088/services/collector"
              className="mt-1.5 w-full rounded-lg border border-line bg-bg px-3 py-2 font-mono text-sm text-ink outline-none placeholder:text-faint focus:border-accent"
            />
          </label>
          <label className="block">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
              Collector token{" "}
              {fwd.hasToken && <span className="normal-case text-faint">— one is stored</span>}
            </span>
            <input
              name="token"
              type="password"
              autoComplete="off"
              placeholder={fwd.hasToken ? "Leave empty to keep it" : "If the collector needs one"}
              className="mt-1.5 w-full rounded-lg border border-line bg-bg px-3 py-2 font-mono text-sm text-ink outline-none placeholder:text-faint focus:border-accent"
            />
            <span className="mt-1 block text-xs text-faint">
              Stored encrypted with this instance&rsquo;s secret.
            </span>
          </label>
          {fwd.hasToken && (
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" name="clearToken" value="1" /> Remove the stored token
            </label>
          )}
          <div className="flex justify-end">
            <button className="h-9 rounded-md bg-accent px-4 text-sm font-medium text-accent-ink">
              Save forwarding
            </button>
          </div>
        </form>
      </details>

      <p className="mb-4 text-sm text-muted">
        Record the head hash somewhere this instance does not control — a
        ticket, a password manager, your own notes. A chain proves nothing on
        its own against anyone who can reach the database file.
      </p>

      <form method="get" className="mb-5 flex flex-wrap items-center gap-2">
        <select
          name="action"
          defaultValue={action ?? ""}
          className="h-8 rounded-md border border-line bg-surface px-2 text-sm text-ink"
        >
          <option value="">Every action</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <button className="h-8 rounded-md border border-line px-3 text-xs text-muted hover:border-accent hover:text-accent">
          Filter
        </button>
      </form>

      {entries.length === 0 ? (
        <p className="text-sm text-faint">
          Nothing recorded yet under these filters.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[52rem] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-[0.1em] text-faint">
                <th className="px-3 py-2 font-semibold">When</th>
                <th className="px-3 py-2 font-semibold">Who</th>
                <th className="px-3 py-2 font-semibold">Action</th>
                <th className="px-3 py-2 font-semibold">Object</th>
                <th className="px-3 py-2 font-semibold">Detail</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-line last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted">
                    {when(e.at)}
                  </td>
                  <td className="px-3 py-2 text-ink">{e.actor_name}</td>
                  <td className="px-3 py-2">
                    <span className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-[11px] text-accent">
                      {e.action}
                    </span>
                  </td>
                  <td className="max-w-[16rem] truncate px-3 py-2 text-muted">
                    {e.object_label || e.object_id || e.object_type}
                  </td>
                  <td className="max-w-[14rem] truncate px-3 py-2 font-mono text-[11px] text-faint">
                    {e.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(pageNo > 1 || entries.length === perPage) && (
        <div className="mt-4 flex items-center gap-3 text-sm">
          {pageNo > 1 && (
            <a
              href={`/admin/audit?page=${pageNo - 1}${action ? `&action=${action}` : ""}`}
              className="text-muted underline"
            >
              Newer
            </a>
          )}
          {entries.length === perPage && (
            <a
              href={`/admin/audit?page=${pageNo + 1}${action ? `&action=${action}` : ""}`}
              className="text-muted underline"
            >
              Older
            </a>
          )}
        </div>
      )}
    </AdminShell>
  );
}
