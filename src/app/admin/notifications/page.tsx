import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getSetting } from "@/lib/settings";
import { saveWebhookAction } from "@/app/actions";
import { AdminShell } from "@/components/AdminShell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Notifications" };

export default async function AdminNotifications({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (me.role !== "admin") redirect("/");
  const { saved } = await searchParams;
  const webhook = getSetting("webhook_url") ?? "";

  return (
    <AdminShell active="/admin/notifications">
      {saved && (
        <p className="mb-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
          Saved.
        </p>
      )}

      <h2 className="wordmark text-[1.4rem] text-ink">Where notifications go</h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Mentions, replies, and change-request activity always land in the
        recipient’s inbox inside Octavo. That needs no configuration and works
        on a disconnected network.
      </p>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        A webhook adds an outbound copy — Slack and Teams both accept these
        directly, and anything that reads JSON will do. The copy is
        best-effort: it is sent after the notification is already recorded, so
        a webhook that is slow or unreachable never delays or fails the action
        that caused it.
      </p>

      <form action={saveWebhookAction} className="mt-6 max-w-2xl">
        <label
          htmlFor="webhook_url"
          className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-faint"
        >
          Webhook URL
        </label>
        <input
          id="webhook_url"
          name="webhook_url"
          type="url"
          defaultValue={webhook}
          placeholder="https://hooks.slack.com/services/…"
          className="mt-2 w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm text-ink outline-none placeholder:text-faint focus:border-accent"
        />
        <p className="mt-2 text-xs text-faint">
          Leave empty to send nothing outbound. On an air-gapped instance this
          should stay empty unless the receiver is on the same network.
        </p>
        <div className="mt-4 flex justify-end">
          <button className="h-9 rounded-md bg-accent px-4 text-sm font-medium text-accent-ink shadow-card transition-transform hover:-translate-y-px">
            Save
          </button>
        </div>
      </form>
    </AdminShell>
  );
}
