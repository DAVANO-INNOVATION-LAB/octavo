import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getSpaceBySlug, pageTree } from "@/lib/data";
import { deleteSpaceAction, updateSpaceAction } from "@/app/actions";
import { SpaceShell } from "@/components/SpaceShell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Space settings" };

export default async function SpaceSettings({
  params,
}: {
  params: Promise<{ space: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { space: spaceSlug } = await params;
  const space = getSpaceBySlug(spaceSlug);
  if (!space) notFound();
  const tree = pageTree(space.id, false);

  return (
    <SpaceShell space={space} tree={tree} editing>
      <div className="mx-auto max-w-xl">
        <h1 className="wordmark text-2xl text-ink">Space settings</h1>
        <form
          action={updateSpaceAction}
          className="mt-8 space-y-5 rounded-2xl border border-line bg-surface p-8 shadow-card"
        >
          <input type="hidden" name="slug" value={space.slug} />
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
              Name
            </span>
            <input
              required
              name="name"
              defaultValue={space.name}
              className="h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none focus:border-accent"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
              Description
            </span>
            <input
              name="description"
              defaultValue={space.description}
              className="h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none focus:border-accent"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
              Shape
            </span>
            <select
              name="kind"
              defaultValue={space.kind}
              className="h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none focus:border-accent"
            >
              <option value="docs">Documentation</option>
              <option value="cookbook">Cookbook</option>
              <option value="articles">Articles</option>
              <option value="wiki">Wiki</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
              Shelf
            </span>
            <input
              name="shelf"
              defaultValue={space.shelf}
              maxLength={40}
              placeholder="Group this space under a named shelf (optional)"
              className="h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none placeholder:text-faint focus:border-accent"
            />
          </label>
          <div className="flex gap-3">
            <label className="block flex-1">
              <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
                Typeface
              </span>
              <select
                name="typeface"
                defaultValue={space.typeface}
                className="h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none focus:border-accent"
              >
                <option value="classic">Classic — Fraunces & Geist</option>
                <option value="atelier">Atelier — serif reading text</option>
                <option value="technical">Technical — all sans</option>
              </select>
            </label>
            <label className="block flex-1">
              <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
                Corners
              </span>
              <select
                name="corners"
                defaultValue={space.corners}
                className="h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none focus:border-accent"
              >
                <option value="rounded">Rounded</option>
                <option value="square">Square</option>
              </select>
            </label>
          </div>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
              Visibility
            </span>
            <select
              name="visibility"
              defaultValue={space.visibility}
              className="h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm text-ink outline-none focus:border-accent"
            >
              <option value="private">Private — members only</option>
              <option value="public">Public — anyone can read published pages</option>
            </select>
          </label>
          <button className="h-10 w-full rounded-lg bg-accent text-sm font-medium text-accent-ink shadow-card transition-transform hover:-translate-y-px">
            Save changes
          </button>
        </form>

        <div className="mt-8 rounded-2xl border border-accent/30 bg-surface p-8">
          <h2 className="text-sm font-semibold text-ink">Danger zone</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            Deleting this space permanently removes all {""}
            of its pages. There is no undo.
          </p>
          <form action={deleteSpaceAction} className="mt-4">
            <input type="hidden" name="slug" value={space.slug} />
            <button className="h-9 rounded-lg border border-accent/40 px-4 text-sm font-medium text-accent transition-colors hover:bg-accent hover:text-accent-ink">
              Delete this space
            </button>
          </form>
        </div>
      </div>
    </SpaceShell>
  );
}
