import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getPageBySlug, getSpaceBySlug } from "@/lib/data";
import { SiteHeader } from "@/components/SiteHeader";
import { ProposeShell } from "@/components/editor/ProposeShell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Propose changes" };

export default async function ProposePage({
  params,
}: {
  params: Promise<{ space: string; page: string }>;
}) {
  const { space: spaceSlug, page: pageSlug } = await params;
  const user = await currentUser();
  if (!user) redirect("/login");
  const space = getSpaceBySlug(spaceSlug);
  if (!space) notFound();
  const page = getPageBySlug(space.id, pageSlug);
  if (!page) notFound();

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">
        <ProposeShell
          pageId={page.id}
          spaceSlug={space.slug}
          pageSlug={page.slug}
          initialTitle={page.title}
          initialContent={page.content}
        />
      </main>
    </div>
  );
}
