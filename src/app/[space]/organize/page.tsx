import Link from "next/link";
import { notFound } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getSpaceBySlug, pageTree } from "@/lib/data";
import { canEditSpace } from "@/lib/roles";
import { SpaceShell } from "@/components/SpaceShell";
import { PageOrganizer } from "@/components/PageOrganizer";

export default async function Organize({ params }: { params: Promise<{ space: string }> }) {
  const { space: slug } = await params;
  const space = getSpaceBySlug(slug);
  if (!space || !canEditSpace(await currentUser(), space.id)) notFound();
  const tree = pageTree(space.id);
  return <SpaceShell space={space} tree={tree} editing>
    <div className="mx-auto max-w-3xl">
      <Link href={`/${space.slug}`} className="text-sm text-accent">Back to space</Link>
      <h1 className="mt-4 text-3xl font-semibold">Organize pages</h1>
      <p className="my-4 text-sm text-muted">Drag documents into order within their section. Changes save immediately and update the reading order. Nested pages stay with their parent.</p>
      <PageOrganizer tree={tree} space={space.slug} />
    </div>
  </SpaceShell>;
}
