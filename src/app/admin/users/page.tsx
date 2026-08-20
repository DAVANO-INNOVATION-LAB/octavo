import { redirect } from "next/navigation";
import { KeyRound, ShieldCheck, Trash2 } from "lucide-react";
import { currentUser, listUsers } from "@/lib/auth";
import {
  deleteUserAction,
  resetTotpAction,
  setRoleAction,
} from "@/app/actions";
import { AdminShell } from "@/components/AdminShell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Users" };

export default async function AdminUsers({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (me.role !== "admin") redirect("/");
  const { error } = await searchParams;
  const users = listUsers();

  return (
    <AdminShell active="/admin/users">
      {error === "self" && (
        <p className="mb-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
          You can’t demote or delete your own account.
        </p>
      )}
      <p className="mb-4 text-sm text-muted">
        {users.length} {users.length === 1 ? "member" : "members"}. Groups
        arrive with SCIM provisioning — for now roles are the boundary:
        admins see this office, members write.
      </p>
      <ul className="space-y-2">
        {users.map((u) => (
          <li
            key={u.id}
            className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-card"
          >
            <span className="wordmark flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm text-accent">
              {u.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-sm font-medium text-ink">
                {u.name}
                {u.role === "admin" && (
                  <ShieldCheck size={13} className="text-accent" />
                )}
                {u.id === me.id && (
                  <span className="text-[10px] uppercase tracking-wide text-faint">
                    you
                  </span>
                )}
              </span>
              <span className="block truncate text-xs text-muted">
                {u.email}
                {u.sso ? " · SSO" : ""}
                {u.has_totp ? " · 2FA" : ""}
              </span>
            </span>
            {u.id !== me.id && (
              <span className="flex shrink-0 items-center gap-1.5">
                <form action={setRoleAction}>
                  <input type="hidden" name="id" value={u.id} />
                  <input
                    type="hidden"
                    name="role"
                    value={u.role === "admin" ? "member" : "admin"}
                  />
                  <button className="h-8 rounded-md border border-line bg-bg px-2.5 text-xs font-medium text-muted transition-colors hover:text-ink">
                    {u.role === "admin" ? "Make member" : "Make admin"}
                  </button>
                </form>
                {u.has_totp === 1 && (
                  <form action={resetTotpAction}>
                    <input type="hidden" name="id" value={u.id} />
                    <button
                      title="Reset two-factor (they sign in with password only until re-enrolled)"
                      className="flex h-8 w-8 items-center justify-center rounded-md text-faint transition-colors hover:bg-surface-2 hover:text-ink"
                    >
                      <KeyRound size={14} />
                    </button>
                  </form>
                )}
                <form action={deleteUserAction}>
                  <input type="hidden" name="id" value={u.id} />
                  <button
                    title="Delete this account"
                    className="flex h-8 w-8 items-center justify-center rounded-md text-faint transition-colors hover:bg-accent-soft hover:text-accent"
                  >
                    <Trash2 size={14} />
                  </button>
                </form>
              </span>
            )}
          </li>
        ))}
      </ul>
    </AdminShell>
  );
}
