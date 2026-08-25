import { notFound, redirect } from "next/navigation";
import { ROLE_BLURB, ROLE_LABEL, SPACE_ROLES } from "@/lib/capabilities";
import { ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { getSpaceBySlug, pageTree } from "@/lib/data";
import { canAdminSpace, listSpaceMembers } from "@/lib/roles";
import {
  createVisitorTokenAction,
  removeSpaceMemberAction,
  revokeVisitorTokenAction,
  setSpaceMemberAction,
} from "@/app/actions";
import { listVisitorTokens } from "@/lib/visitors";
import { cookies } from "next/headers";
import { Link2, Link2Off } from "lucide-react";
import { SpaceShell } from "@/components/SpaceShell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Space members" };

export default async function SpaceMembers({
  params,
  searchParams,
}: {
  params: Promise<{ space: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { space: slug } = await params;
  const { error } = await searchParams;
  const space = getSpaceBySlug(slug);
  if (!space) notFound();
  if (!canAdminSpace(user, space.id)) redirect(`/${space.slug}`);

  const members = listSpaceMembers(space.id);
  const tree = pageTree(space.id, false);

  // A just-issued visitor link, shown exactly once. See the action: the
  // secret travels in a one-minute httpOnly cookie, never in the URL.
  const jar = await cookies();
  let freshLink: string | null = null;
  try {
    const flash = JSON.parse(jar.get("octavo_new_visit")?.value ?? "null");
    if (flash?.space === space.slug) freshLink = `/visit/${flash.token}`;
  } catch {
    /* no fresh link */
  }
  const tokens =
    space.visibility === "private" ? listVisitorTokens(space.id) : [];


  return (
    <SpaceShell space={space} tree={tree} editing rail={null}>
      <div className="mx-auto max-w-2xl">
        <h1 className="wordmark text-2xl text-ink">Who works on {space.name}</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          Four roles, and what each one means here.
        </p>
        <ul className="mt-3 space-y-1 text-sm text-muted">
          {SPACE_ROLES.map((r) => (
            <li key={r}>
              <span className="font-medium text-ink">{ROLE_LABEL[r]}</span> —{" "}
              {ROLE_BLURB[r]}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-muted">
          Instance admins administer every space. An AI Agent is capped at
          reading and proposing no matter what else it is granted.
        </p>

        {error === "nouser" && (
          <p className="mt-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
            No account with that email. They need to sign in once first.
          </p>
        )}

        <ul className="mt-6 space-y-2">
          {members.map((m) => (
            <li
              key={m.user_id}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-card"
            >
              <span className="wordmark flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm text-accent">
                {m.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                  {m.name}
                  {m.role === "admin" && (
                    <ShieldCheck size={13} className="text-accent" />
                  )}
                </span>
                <span className="block truncate text-xs text-muted">
                  {m.email} · {ROLE_LABEL[m.role] ?? m.role}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <form action={setSpaceMemberAction} className="flex items-center gap-1.5">
                  <input type="hidden" name="space" value={space.slug} />
                  <input type="hidden" name="email" value={m.email} />
                  <select
                    name="role"
                    defaultValue={m.role}
                    className="h-8 rounded-md border border-line bg-bg px-2 text-xs text-muted"
                  >
                    {SPACE_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                  <button className="h-8 rounded-md border border-line bg-bg px-2.5 text-xs font-medium text-muted transition-colors hover:text-ink">
                    Set
                  </button>
                </form>
                <form action={removeSpaceMemberAction}>
                  <input type="hidden" name="space" value={space.slug} />
                  <input type="hidden" name="userId" value={m.user_id} />
                  <button
                    title="Remove from this space"
                    className="flex h-8 w-8 items-center justify-center rounded-md text-faint transition-colors hover:bg-accent-soft hover:text-accent"
                  >
                    <Trash2 size={14} />
                  </button>
                </form>
              </span>
            </li>
          ))}
          {members.length === 0 && (
            <li className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-faint">
              No one is assigned to this space yet — instance admins can still
              administer it.
            </li>
          )}
        </ul>

        <form
          action={setSpaceMemberAction}
          className="mt-8 space-y-4 rounded-2xl border border-line bg-surface p-6 shadow-card"
        >
          <input type="hidden" name="space" value={space.slug} />
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <UserPlus size={15} className="text-accent" />
            Add someone
          </h2>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              required
              name="email"
              type="email"
              placeholder="their@email.com"
              className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none focus:border-accent"
            />
            <select
              name="role"
              className="h-10 rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none focus:border-accent"
            >
              {SPACE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
            <button className="h-10 shrink-0 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink shadow-card">
              Add
            </button>
          </div>
        </form>

        {space.visibility === "private" && (
          <section className="mt-8 rounded-2xl border border-line bg-surface p-6 shadow-card">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Link2 size={15} className="text-accent" />
              Visitor links
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              A visitor link opens this space — read only, this space only —
              to someone without an account, until it expires or you revoke
              it. The link is shown once when created and cannot be recovered;
              lose it and you issue another.
            </p>

            {freshLink && (
              <p className="mt-4 rounded-lg bg-accent-soft px-3 py-3 text-sm text-accent">
                Copy it now — it will not be shown again:
                <code className="mt-1 block break-all font-mono text-xs">
                  {freshLink}
                </code>
              </p>
            )}

            {tokens.length > 0 && (
              <ul className="mt-4 space-y-2">
                {tokens.map((t) => {
                  const dead = t.dead;
                  return (
                    <li
                      key={t.id}
                      className="flex items-center gap-3 rounded-lg border border-line px-3 py-2"
                    >
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-sm ${dead ? "text-faint line-through" : "text-ink"}`}>
                          {t.label || "Unlabelled link"}
                        </span>
                        <span className="block text-xs text-faint">
                          {dead
                            ? t.revoked_at
                              ? "revoked"
                              : "expired"
                            : `expires ${new Date(t.expires_at).toLocaleDateString()}`}
                          {" · "}
                          {t.uses} {t.uses === 1 ? "visit" : "visits"}
                        </span>
                      </span>
                      {!dead && (
                        <form action={revokeVisitorTokenAction}>
                          <input type="hidden" name="space" value={space.slug} />
                          <input type="hidden" name="id" value={t.id} />
                          <button
                            title="Revoke — the link stops working on the next click"
                            className="flex h-8 w-8 items-center justify-center rounded-md text-faint transition-colors hover:bg-accent-soft hover:text-accent"
                          >
                            <Link2Off size={14} />
                          </button>
                        </form>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            <form
              action={createVisitorTokenAction}
              className="mt-4 flex flex-col gap-3 sm:flex-row"
            >
              <input type="hidden" name="space" value={space.slug} />
              <input
                name="label"
                placeholder="Who is this for?"
                className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none focus:border-accent"
              />
              <select
                name="days"
                defaultValue="7"
                aria-label="How long the link lasts"
                className="h-10 rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none focus:border-accent"
              >
                <option value="1">1 day</option>
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
              </select>
              <button className="h-10 shrink-0 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink shadow-card">
                Issue link
              </button>
            </form>
          </section>
        )}
      </div>
    </SpaceShell>
  );
}
