import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getPageBySlug, getSpaceBySlug } from "@/lib/data";
import { pageToMarkdown } from "@/lib/transfer";

/** /space/page/raw — the page as Markdown, for agents and for copying. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ space: string; page: string }> }
) {
  const { space: spaceSlug, page: pageSlug } = await params;
  const space = getSpaceBySlug(spaceSlug);
  if (!space) return new NextResponse("not found", { status: 404 });
  const page = getPageBySlug(space.id, pageSlug.replace(/\.md$/, ""));
  if (!page) return new NextResponse("not found", { status: 404 });

  const user = await currentUser();
  if ((space.visibility === "private" || page.published === 0) && !user)
    return new NextResponse("not found", { status: 404 });

  return new NextResponse(pageToMarkdown(page.id) ?? "", {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=60",
    },
  });
}
