import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { policy, DEFAULT_POLICY } from "@/lib/policy";
import { savePolicyAction } from "@/app/actions";
import { AdminShell } from "@/components/AdminShell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Policy" };

const FIELDS: {
  name: keyof typeof DEFAULT_POLICY;
  label: string;
  hint: string;
  unit: string;
}[] = [
  {
    name: "sessionDays",
    label: "Session length",
    hint: "How long someone stays signed in without signing in again.",
    unit: "days",
  },
  {
    name: "lockoutThreshold",
    label: "Failed attempts before lockout",
    hint: "Counted per account, inside the window below.",
    unit: "attempts",
  },
  {
    name: "lockoutWindowMinutes",
    label: "Counting window",
    hint: "Failures older than this stop counting.",
    unit: "minutes",
  },
  {
    name: "lockoutMinutes",
    label: "Lockout length",
    hint: "How long the account refuses passwords once locked.",
    unit: "minutes",
  },
  {
    name: "minPasswordLength",
    label: "Minimum password length",
    hint: "Applies when a password is set or changed; existing ones keep working.",
    unit: "characters",
  },
  {
    name: "auditRetentionDays",
    label: "Audit log retention",
    hint: "0 keeps the log forever. Pruned entries are gone, not archived.",
    unit: "days",
  },
];

export default async function AdminPolicy({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (me.role !== "admin") redirect("/");
  const { saved } = await searchParams;
  const p = policy();

  return (
    <AdminShell active="/admin/policy">
      {saved && (
        <p className="mb-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
          Saved.
        </p>
      )}

      <h2 className="wordmark text-[1.4rem] text-ink">Instance policy</h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        The knobs a security review asks about. The defaults are sensible and
        most instances never touch this page; the point is that when your
        rules say a different number, the software does not argue.
      </p>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Lockout counts failures per account, not per address — that is what
        actually bounds a guessing attack. Every failure lands in the audit
        log either way.
      </p>

      <form action={savePolicyAction} className="mt-6 max-w-2xl space-y-4">
        {FIELDS.map((f) => (
          <label
            key={f.name}
            className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4 sm:flex-row sm:items-center"
          >
            <span className="flex-1">
              <span className="block text-sm font-medium text-ink">
                {f.label}
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                {f.hint}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <input
                type="number"
                name={f.name}
                defaultValue={p[f.name]}
                className="h-9 w-24 rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none focus:border-accent"
              />
              <span className="w-20 text-xs text-faint">{f.unit}</span>
            </span>
          </label>
        ))}
        <button
          type="submit"
          className="h-9 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink"
        >
          Save
        </button>
      </form>
    </AdminShell>
  );
}
