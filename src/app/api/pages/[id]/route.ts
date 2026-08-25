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

  // Parse defensively: a non-JSON body, or a valid-JSON non-object like
  // `null` or `[1,2,3]`, must be a 400, never a 500 from touching `.title`
  // on a null.
  let body: { title?: unknown; content?: unknown };
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    body = parsed as { title?: unknown; content?: unknown };
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
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
