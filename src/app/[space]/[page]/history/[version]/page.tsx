import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { currentUser } from "@/lib/auth";
import {
  getPageBySlug,
  getSpaceBySlug,
  getVersion,
  pageTree,
} from "@/lib/data";
import { parseBlocks } from "@/lib/blocks";
import { restoreVersionAction } from "@/app/actions";
import { SpaceShell } from "@/components/SpaceShell";
import { Renderer } from "@/components/render/Renderer";

export const dynamic = "force-dynamic";

export const metadata = { title: "Version" };

export default async function VersionPage({
  params,
}: {
  params: Promise<{ space: string; page: string; version: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { space: spaceSlug, page: pageSlug, version: versionId } = await params;
  const space = getSpaceBySlug(spaceSlug);
  if (!space) notFound();
  const page = getPageBySlug(space.id, pageSlug);
  if (!page) notFound();
  const version = getVersion(versionId);
  if (!version || version.page_id !== page.id) notFound();

  const tree = pageTree(space.id, false);

  return (
    <SpaceShell space={space} tree={tree} activeId={page.id} editing rail={null}>
      <article className="mx-auto max-w-2xl">
        <div className="mb-8 flex flex-wrap items-center gap-3 rounded-xl border border-accent/40 bg-accent-soft px-4 py-3">
          <p className="min-w-0 flex-1 text-sm text-ink">
            Reading the version from{" "}
            <strong>
              {new Date(version.saved_at).toLocaleString(undefined, {
                month: "long",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </strong>
            . The live page is untouched.
          </p>
          <form action={restoreVersionAction} className="flex items-center gap-2">
            <input type="hidden" name="versionId" value={version.id} />
            <input type="hidden" name="space" value={space.slug} />
            <button className="h-8 rounded-md bg-accent px-3 text-xs font-medium text-accent-ink shadow-card transition-transform hover:-translate-y-px">
              Restore this version
            </button>
          </form>
          <Link
            href={`/${space.slug}/${page.slug}/history`}
            className="flex items-center gap-1 text-xs font-medium text-muted hover:text-ink"
          >
            <ArrowLeft size={12} />
            History
          </Link>
        </div>

        <h1
          className="wordmark mb-8 text-[2.4rem] leading-[1.15] text-ink"
          style={{ fontVariationSettings: '"opsz" 60' }}
        >
          {version.title}
        </h1>
        <Renderer blocks={parseBlocks(version.content)} />
      </article>
    </SpaceShell>
  );
}
