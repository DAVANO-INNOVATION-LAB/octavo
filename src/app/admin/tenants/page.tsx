import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser, listUsers } from "@/lib/auth";
import { EVERYTHING, listSpaces } from "@/lib/data";
import { listTenants, membersOf } from "@/lib/tenants";
import {
  addTenantMemberAction,
  createTenantAction,
  deleteTenantAction,
  removeTenantMemberAction,
  setSpaceTenantAction,
  updateTenantAction,
} from "@/app/actions";
import { AdminShell } from "@/components/AdminShell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tenants" };

export default async function AdminTenants({
  searchParams,
}: {
  searchParams: Promise<{ tenant?: string; saved?: string }>;
}) {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (me.role !== "admin") redirect("/");
  const { tenant: selected, saved } = await searchParams;

  const tenants = listTenants();
  const current = tenants.find((t) => t.slug === selected) ?? tenants[0] ?? null;
  const spaces = listSpaces(EVERYTHING);
  const members = current ? membersOf(current.id) : [];
  const memberIds = new Set(members.map((m) => m.id));
  const users = listUsers();

  const field =
    "h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none placeholder:text-faint focus:border-accent";
  const label = "mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint";

  return (
    <AdminShell active="/admin/tenants">
      {saved && (
        <p className="mb-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">Saved.</p>
      )}

      <h2 className="wordmark text-[1.4rem] text-ink">Tenants</h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        A tenant is a silo. Its spaces do not exist for anyone outside it —
        including the public ones, because &ldquo;public&rdquo; means public
        within a tenant. This is stronger than a private space: knowing the
        name of a tenant&rsquo;s space is not enough to open it.
      </p>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Spaces in no tenant belong to the library and stay visible to everyone,
        which is what every space is until you move it. Instance admins stand
        outside tenancy — somebody has to be able to run the instance.
      </p>

      <form action={createTenantAction} className="mt-6 flex max-w-2xl gap-2">
        <input name="name" placeholder="A new tenant's name" className={field} required />
        <button className="h-10 shrink-0 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink">
          Create
        </button>
      </form>

      {tenants.length > 0 && (
        <div className="mt-8 flex flex-wrap gap-2">
          {tenants.map((t) => (
            <Link
              key={t.id}
              href={`/admin/tenants?tenant=${t.slug}`}
              className={`h-8 rounded-full border px-3 text-sm leading-8 transition-colors ${
                current?.id === t.id
                  ? "border-accent bg-accent text-accent-ink"
                  : "border-line text-muted hover:text-ink"
              }`}
            >
              {t.name}
            </Link>
          ))}
        </div>
      )}

      {current && (
        <>
          <form action={updateTenantAction} className="mt-8 max-w-2xl space-y-4">
            <input type="hidden" name="id" value={current.id} />
            <label className="block">
              <span className={label}>Name</span>
              <input name="name" defaultValue={current.name} className={field} />
            </label>
            <label className="block">
              <span className={label}>Group claim</span>
              <input
                name="claim_value"
                defaultValue={current.claim_value}
                placeholder="the SSO group that puts someone in this tenant"
                className={`${field} font-mono text-xs`}
              />
              <span className="mt-1 block text-xs text-faint">
                Members are reconciled from this on every sign-in. Anyone added
                by hand below stays added: a claim that stops appearing does not
                silently revoke access an administrator granted deliberately.
              </span>
            </label>
            <button className="h-9 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink">
              Save
            </button>
          </form>

          <h3 className="mt-10 text-sm font-medium text-ink">Spaces in this tenant</h3>
          <div className="mt-3 space-y-2">
            {spaces.map((sp) => (
              <form
                key={sp.id}
                action={setSpaceTenantAction}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-line px-3 py-2"
              >
                <input type="hidden" name="tenant" value={current.slug} />
                <input type="hidden" name="space" value={sp.id} />
                <label className="flex flex-1 items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    name="in"
                    defaultChecked={sp.tenant_id === current.id}
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                  {sp.name}
                  {sp.tenant_id && sp.tenant_id !== current.id && (
                    <span className="text-[11px] uppercase tracking-[0.1em] text-faint">
                      in {tenants.find((t) => t.id === sp.tenant_id)?.name ?? "another tenant"}
                    </span>
                  )}
                </label>
                <button className="h-8 rounded-md border border-line px-3 text-xs text-muted hover:text-ink">
                  Apply
                </button>
              </form>
            ))}
          </div>

          <h3 className="mt-10 text-sm font-medium text-ink">Members</h3>
          <div className="mt-3 space-y-2">
            {members.map((m) => (
              <form
                key={m.id}
                action={removeTenantMemberAction}
                className="flex items-center gap-3 rounded-lg border border-line px-3 py-2"
              >
                <input type="hidden" name="tenant" value={current.slug} />
                <input type="hidden" name="id" value={current.id} />
                <input type="hidden" name="user" value={m.id} />
                <span className="flex-1 text-sm text-ink">
                  {m.name}
                  <span className="ml-2 text-xs text-faint">{m.email}</span>
                  {m.from_claim === 1 && (
                    <span className="ml-2 text-[11px] uppercase tracking-[0.1em] text-faint">
                      from SSO
                    </span>
                  )}
                </span>
                <button className="text-xs text-muted hover:text-accent">Remove</button>
              </form>
            ))}
            {members.length === 0 && (
              <p className="text-sm text-muted">Nobody is in this tenant yet.</p>
            )}
          </div>
          <form action={addTenantMemberAction} className="mt-3 flex max-w-2xl gap-2">
            <input type="hidden" name="tenant" value={current.slug} />
            <input type="hidden" name="id" value={current.id} />
            <select name="user" className={field} required>
              <option value="">Add somebody…</option>
              {users
                .filter((u) => !memberIds.has(u.id))
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} · {u.email}
                  </option>
                ))}
            </select>
            <button className="h-10 shrink-0 rounded-lg border border-line px-4 text-sm text-muted hover:text-ink">
              Add
            </button>
          </form>

          <form action={deleteTenantAction} className="mt-10">
            <input type="hidden" name="id" value={current.id} />
            <button className="h-9 rounded-lg border border-line px-4 text-sm text-muted hover:text-accent">
              Delete this tenant
            </button>
            <span className="ml-3 text-xs text-faint">
              Its spaces return to the library. No space or page is deleted.
            </span>
          </form>
        </>
      )}
    </AdminShell>
  );
}
