import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { canReadSpace, canEditSpace } from "@/lib/roles";
import { getPage } from "@/lib/data";
import { getDb } from "@/lib/db";
import { pageToMarkdown } from "@/lib/transfer";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const page = getPage(id);
  if (!page) return new NextResponse("not found", { status: 404 });

  const space = getDb()
    .prepare("SELECT id, visibility FROM spaces WHERE id = ?")
    .get(page.space_id) as { id: string; visibility: string } | undefined;
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
      "Content-Disposition": `attachment; filename="${page.slug}.md"`,
    },
  });
}
