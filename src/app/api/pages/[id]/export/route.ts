import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { canReadSpace, canEditSpace } from "@/lib/roles";
import { getPage, getSpace } from "@/lib/data";
import { pageToMarkdown } from "@/lib/transfer";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const page = getPage(id);
  if (!page) return new NextResponse("not found", { status: 404 });

  const space = getSpace(page.space_id);
  if (!space) return new NextResponse("not found", { status: 404 });
  const user = await currentUser();
  if (!canReadSpace(user, space))
    return new NextResponse("unauthorized", { status: 401 });
  if (page.published === 0 && !canEditSpace(user, space.id))
    return new NextResponse("unauthorized", { status: 401 });

  const md = pageToMarkdown(id);
  return new NextResponse(md ?? "", {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Vary": "Cookie",
      "Content-Disposition": `attachment; filename="${page.slug}.md"`,
    },
  });
}
