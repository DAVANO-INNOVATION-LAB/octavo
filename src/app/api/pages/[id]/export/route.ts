import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
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
    .prepare("SELECT visibility FROM spaces WHERE id = ?")
    .get(page.space_id) as { visibility: string } | undefined;
  const user = await currentUser();
  const restricted = page.published === 0 || space?.visibility === "private";
  if (restricted && !user)
    return new NextResponse("unauthorized", { status: 401 });

  const md = pageToMarkdown(id);
  return new NextResponse(md ?? "", {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${page.slug}.md"`,
    },
  });
}
