import { notFound, redirect } from "next/navigation";
import { ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { getSpaceBySlug, pageTree } from "@/lib/data";
import { canAdminSpace, listSpaceMembers } from "@/lib/roles";
import { removeSpaceMemberAction, setSpaceMemberAction } from "@/app/actions";
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

  return (
    <SpaceShell space={space} tree={tree} editing rail={null}>
      <div className="mx-auto max-w-2xl">
        <h1 className="wordmark text-2xl text-ink">Who works on {space.name}</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          A space admin runs this space: its settings, its members, and its own
          connectors. Instance admins can administer every space.
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
                  {m.email} · space {m.role}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <form action={setSpaceMemberAction}>
                  <input type="hidden" name="space" value={space.slug} />
                  <input type="hidden" name="email" value={m.email} />
                  <input
                    type="hidden"
                    name="role"
                    value={m.role === "admin" ? "editor" : "admin"}
                  />
                  <button className="h-8 rounded-md border border-line bg-bg px-2.5 text-xs font-medium text-muted transition-colors hover:text-ink">
                    {m.role === "admin" ? "Make editor" : "Make space admin"}
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
              <option value="editor">Editor</option>
              <option value="admin">Space admin</option>
            </select>
            <button className="h-10 shrink-0 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink shadow-card">
              Add
            </button>
          </div>
        </form>
      </div>
    </SpaceShell>
  );
}
