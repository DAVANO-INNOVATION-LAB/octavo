import { redirect } from "next/navigation";
import { Users, Trash2 } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { listSpaces } from "@/lib/data";
import { groupGrants, groupMembers, listGroups } from "@/lib/groups";
import { ROLE_LABEL, SPACE_ROLES } from "@/lib/capabilities";
import {
  createGroupAction,
  deleteGroupAction,
  groupClaimAction,
  groupGrantAction,
  groupMemberAction,
} from "@/app/actions";
import { AdminShell } from "@/components/AdminShell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Groups" };

export default async function AdminGroups({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (me.role !== "admin") redirect("/");
  const { error } = await searchParams;

  const groups = listGroups();
  const spaces = listSpaces("all");
  const bySpace = new Map(spaces.map((s) => [s.id, s]));

  return (
    <AdminShell active="/admin/groups">
      <h2 className="wordmark text-[1.4rem] text-ink">Groups</h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        A group grants a role in one or more spaces to a set of people at
        once. Someone in two groups gets the stronger role; a group never
        takes away what a direct membership already grants.
      </p>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Give a group a <em>claim value</em> and single sign-on takes over its
        membership: accounts carrying that value in their{" "}
        <code className="text-xs">groups</code> claim are added on sign-in,
        and accounts that stop carrying it are removed. People added by hand
        stay until removed by hand.
      </p>

      {error === "nouser" && (
        <p className="mt-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
          No account with that email. They need to sign in once first.
        </p>
      )}

      <div className="mt-6 space-y-5">
        {groups.map((g) => {
          const members = groupMembers(g.id);
          const grants = groupGrants(g.id);
          return (
            <section
              key={g.id}
              className="rounded-2xl border border-line bg-surface p-5 shadow-card"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
                    <Users size={15} className="text-accent" />
                    {g.name}
                  </h3>
                  <form
                    action={groupClaimAction}
                    className="mt-2 flex items-center gap-2"
                  >
                    <input type="hidden" name="group" value={g.id} />
                    <input
                      name="claim"
                      defaultValue={g.claim_value}
                      placeholder="SSO claim value (optional)"
                      className="h-8 w-64 rounded-md border border-line bg-bg px-2 text-xs text-ink outline-none focus:border-accent"
                    />
                    <button className="h-8 rounded-md border border-line px-2.5 text-xs text-muted hover:border-line-strong hover:text-ink">
                      Save
                    </button>
                  </form>
                </div>
                <form action={deleteGroupAction}>
                  <input type="hidden" name="id" value={g.id} />
                  <button
                    title="Delete this group and every grant it carries"
                    className="flex h-8 w-8 items-center justify-center rounded-md text-faint transition-colors hover:bg-accent-soft hover:text-accent"
                  >
                    <Trash2 size={14} />
                  </button>
                </form>
              </div>

              <div className="mt-4 grid gap-5 sm:grid-cols-2">
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-faint">
                    People ({members.length})
                  </h4>
                  <ul className="mt-2 space-y-1">
                    {members.map((m) => (
                      <li
                        key={m.user_id}
                        className="flex items-center gap-2 text-sm text-muted"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {m.name}
                          {m.from_claim === 1 && (
                            <span className="ml-1.5 text-[10px] uppercase tracking-wide text-faint">
                              via SSO
                            </span>
                          )}
                        </span>
                        <form action={groupMemberAction}>
                          <input type="hidden" name="group" value={g.id} />
                          <input type="hidden" name="remove" value={m.user_id} />
                          <button className="text-xs text-faint hover:text-accent">
                            remove
                          </button>
                        </form>
                      </li>
                    ))}
                    {members.length === 0 && (
                      <li className="text-xs text-faint">Nobody yet.</li>
                    )}
                  </ul>
                  <form action={groupMemberAction} className="mt-2 flex gap-2">
                    <input type="hidden" name="group" value={g.id} />
                    <input
                      required
                      name="email"
                      type="email"
                      placeholder="their@email.com"
                      className="h-8 min-w-0 flex-1 rounded-md border border-line bg-bg px-2 text-xs text-ink outline-none focus:border-accent"
                    />
                    <button className="h-8 shrink-0 rounded-md border border-line px-2.5 text-xs text-muted hover:border-line-strong hover:text-ink">
                      Add
                    </button>
                  </form>
                </div>

                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-faint">
                    Spaces ({grants.length})
                  </h4>
                  <ul className="mt-2 space-y-1">
                    {grants.map((gr) => (
                      <li
                        key={gr.space_id}
                        className="flex items-center gap-2 text-sm text-muted"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {bySpace.get(gr.space_id)?.name ?? gr.space_id}
                        </span>
                        <span className="text-xs text-faint">
                          {ROLE_LABEL[gr.role] ?? gr.role}
                        </span>
                        <form action={groupGrantAction}>
                          <input type="hidden" name="group" value={g.id} />
                          <input
                            type="hidden"
                            name="space"
                            value={bySpace.get(gr.space_id)?.slug ?? ""}
                          />
                          <input type="hidden" name="role" value="none" />
                          <button className="text-xs text-faint hover:text-accent">
                            remove
                          </button>
                        </form>
                      </li>
                    ))}
                    {grants.length === 0 && (
                      <li className="text-xs text-faint">No spaces yet.</li>
                    )}
                  </ul>
                  <form action={groupGrantAction} className="mt-2 flex gap-2">
                    <input type="hidden" name="group" value={g.id} />
                    <select
                      name="space"
                      aria-label="Space to grant"
                      className="h-8 min-w-0 flex-1 rounded-md border border-line bg-bg px-2 text-xs text-ink outline-none focus:border-accent"
                    >
                      {spaces.map((s) => (
                        <option key={s.id} value={s.slug}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                    <select
                      name="role"
                      aria-label="Role to grant"
                      className="h-8 rounded-md border border-line bg-bg px-2 text-xs text-ink outline-none focus:border-accent"
                    >
                      {SPACE_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </select>
                    <button className="h-8 shrink-0 rounded-md border border-line px-2.5 text-xs text-muted hover:border-line-strong hover:text-ink">
                      Grant
                    </button>
                  </form>
                </div>
              </div>
            </section>
          );
        })}
      </div>

      <form
        action={createGroupAction}
        className="mt-6 flex max-w-2xl flex-col gap-3 rounded-2xl border border-line bg-surface p-5 shadow-card sm:flex-row"
      >
        <input
          required
          name="name"
          placeholder="Group name — Research, Contractors, Platform…"
          className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none focus:border-accent"
        />
        <input
          name="claim"
          placeholder="SSO claim value (optional)"
          className="h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none focus:border-accent sm:w-56"
        />
        <button className="h-10 shrink-0 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink shadow-card">
          Create group
        </button>
      </form>
    </AdminShell>
  );
}
