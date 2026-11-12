import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { canEditSpace, canReadSpace, canReadSpaceAsVisitor } from "@/lib/roles";
import { getPageBySlug, getSpaceBySlug } from "@/lib/data";
import { pageToMarkdown } from "@/lib/transfer";

export const dynamic = "force-dynamic";

/** /space/page/raw — the page as Markdown, for agents and for copying. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ space: string; page: string }> }
) {
  const { space: spaceSlug, page: pageSlug } = await params;
  const space = getSpaceBySlug(spaceSlug);
  if (!space) return new NextResponse("not found", { status: 404 });
  const user = await currentUser();
  if (!(await canReadSpaceAsVisitor(user, space)))
    return new NextResponse("not found", { status: 404 });
  const page = getPageBySlug(space.id, pageSlug.replace(/\.md$/, ""));
  if (!page) return new NextResponse("not found", { status: 404 });
  // A draft is not published content. Reading one is the writers' business,
  // not every signed-in account's.
  if (page.published === 0 && (!canReadSpace(user, space) || !canEditSpace(user, space.id)))
    return new NextResponse("not found", { status: 404 });

  return new NextResponse(pageToMarkdown(page.id) ?? "", {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0",
    },
  });
}
