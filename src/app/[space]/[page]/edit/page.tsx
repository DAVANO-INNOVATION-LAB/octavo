import { exchangeManagedPage } from "@/lib/site-exchange-delete-guard";
import { collaborationEnabled } from "@/lib/collab-config";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { BookOpen, History, Trash2 } from "lucide-react";
import { currentUser } from "@/lib/auth";
import { canEditSpace, canReadSpace } from "@/lib/roles";
import { getPage, getPageBySlug, getSpaceBySlug, pageTree } from "@/lib/data";
import { deletePageAction, publishPageAction } from "@/app/actions";
import { SpaceShell } from "@/components/SpaceShell";
import { getDb } from "@/lib/db";
import { pageRevision } from "@/lib/page-revisions";
import { EditorShell } from "@/components/editor/EditorShell";

export const dynamic = "force-dynamic";

export default async function EditPage({
  params,
}: {
  params: Promise<{ space: string; page: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");

  const { space: spaceSlug, page: pageSlug } = await params;
  const space = getSpaceBySlug(spaceSlug);
  if (!space || !canReadSpace(user, space) || !canEditSpace(user, space.id)) notFound();
  const found = getPageBySlug(space.id, pageSlug);
  if (!found) notFound();
  const snapshot = getDb().transaction(() => {
    const page = getPage(found.id);
    return page && page.space_id === space.id ? { page, ...pageRevision(page.id) } : null;
  })();
  if (!snapshot) notFound();
  const { page, revision, epoch } = snapshot;

  const tree = pageTree(space.id, false);

  return (
    <SpaceShell space={space} tree={tree} activeId={page.id} editing rail={null}>
      <div className="measured">
        <div className="mb-6 flex flex-wrap items-center gap-2 border-b border-line pb-4">
          <span
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.06em] ${
              page.published === 1
                ? "bg-accent-soft text-accent"
                : "bg-surface-2 text-muted"
            }`}
          >
            {page.published === 1 ? "Published" : "Draft"}
          </span>
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
            <Link href={`/quality?page=${page.id}`} className="text-xs underline">Review & checks</Link>
            <form action={publishPageAction}>
              <input type="hidden" name="id" value={page.id} />
              <input type="hidden" name="space" value={space.slug} />
              <input
                type="hidden"
                name="publish"
                value={page.published === 1 ? "0" : "1"}
              />
              <button
                className={`flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors ${
                  page.published === 1
                    ? "border border-line bg-surface text-muted hover:text-ink"
                    : "bg-accent text-accent-ink shadow-card"
                }`}
              >
                {page.published === 1 ? "Unpublish" : "Publish page"}
              </button>
            </form>
            {page.published === 1 && (
              <Link
                href={`/${space.slug}/${page.slug}`}
                className="flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-xs font-medium text-muted transition-colors hover:text-ink"
              >
                <BookOpen size={13} />
                View
              </Link>
            )}
            <Link
              href={`/${space.slug}/${page.slug}/history`}
              className="flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-xs font-medium text-muted transition-colors hover:text-ink"
            >
              <History size={13} />
              History
            </Link>
            {exchangeManagedPage(page.id,space.id)?<Link href={`/${space.slug}/${page.slug}/delete`} aria-label="Archive and delete exchange page" className="flex h-8 items-center rounded-md px-2 text-xs text-muted hover:text-ink">Archive & delete</Link>:<form action={deletePageAction}>
              <input type="hidden" name="id" value={page.id} />
              <input type="hidden" name="space" value={space.slug} />
              <button
                aria-label="Delete page"
                className="flex h-8 w-8 items-center justify-center rounded-md text-faint transition-colors hover:bg-accent-soft hover:text-accent"
              >
                <Trash2 size={14} />
              </button>
            </form>}
          </div>
        </div>
        <EditorShell
          pageId={page.id}
          spaceSlug={space.slug}
          pageSlug={page.slug}
          initialRevision={revision}
          initialEpoch={epoch}
          collaborationEnabled={collaborationEnabled()}
          initialUserId={user.id}
          initialTitle={page.title}
          initialContent={page.content}
          modelKind={space.model_kind}
        />
      </div>
    </SpaceShell>
  );
}
