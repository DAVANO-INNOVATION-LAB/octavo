import { redirect } from "next/navigation";
import { KeyRound, ShieldCheck, Trash2, FileDown } from "lucide-react";
import { currentUser, listUsers } from "@/lib/auth";
import {
  deleteUserAction,
  resetTotpAction,
  setRoleAction,
} from "@/app/actions";
import { AddUserForm } from "@/components/AddUserForm";
import { AdminShell } from "@/components/AdminShell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Users" };

export default async function AdminUsers({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; created?: string }>;
}) {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (me.role !== "admin") redirect("/");
  const { error, created } = await searchParams;
  const errors: Record<string, string> = { name: "Enter a name of 1–120 characters.", email: "Enter a valid email address.", password: "Use a password of 12–128 characters.", role: "Choose Member or Administrator.", duplicate: "An account with that email already exists." };
  const users = listUsers();

  return (
    <AdminShell active="/admin/users">
      {error === "self" && (
        <p className="mb-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
          You can’t demote or delete your own account.
        </p>
      )}
      {created === "1" && <p role="status" className="mb-4 rounded-lg bg-accent-soft p-3 text-sm text-accent">User created. Assign space access from the space’s Members page.</p>}
      {error && errors[error] && <p role="alert" className="mb-4 rounded-lg bg-accent-soft p-3 text-sm text-accent">{errors[error]}</p>}
      <AddUserForm />
      <p className="mb-4 text-sm text-muted">
        {users.length} {users.length === 1 ? "member" : "members"}. Manage local accounts here and space permissions from each space’s Members page.
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
                <a
                  href={`/api/users/${u.id}/export`}
                  title="Download everything the instance holds about this person"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-faint transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  <FileDown size={14} />
                </a>
                <form action={deleteUserAction}>
                  <input type="hidden" name="id" value={u.id} />
                  <button
                    title="Delete this account — removes their sessions, memberships, comments and notifications"
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
