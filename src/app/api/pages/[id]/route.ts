import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getPage, savePage } from "@/lib/data";
import { canEditSpace } from "@/lib/roles";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const page = getPage(id);
  if (!page)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  // Being signed in is not permission to rewrite the library. This is the
  // route the whole role matrix hangs on: without the check here, a reader
  // and an agent both write, whatever the matrix says.
  if (!canEditSpace(user, page.space_id))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = (await req.json()) as { title?: string; content?: unknown };
  const fields: { title?: string; content?: string } = {};
  if (typeof body.title === "string") fields.title = body.title;
  if (body.content !== undefined) {
    if (!Array.isArray(body.content))
      return NextResponse.json({ error: "bad content" }, { status: 400 });
    fields.content = JSON.stringify(body.content);
  }
  const saved = savePage(id, fields);
  return NextResponse.json({
    ok: true,
    slug: saved?.slug,
    updated_at: saved?.updated_at,
  });
}
