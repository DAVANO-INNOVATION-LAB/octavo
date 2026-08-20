import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getPage } from "@/lib/data";
import { may } from "@/lib/roles";

/**
 * Whether the caller may co-edit a page, answered for the collaboration
 * server.
 *
 * That server runs outside the Next bundle — it is attached to the same HTTP
 * listener so collaboration needs no second port — and it must not carry its
 * own copy of the permission rules. It forwards the request's cookies here
 * instead, so the capability matrix is consulted in exactly one place and
 * cannot drift out of step with the rest of the app.
 */
export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  const pageId = req.nextUrl.searchParams.get("page") ?? "";
  const page = getPage(pageId);
  if (!page) return NextResponse.json({ ok: false }, { status: 404 });

  if (!may(user, page.space_id, "write"))
    return NextResponse.json({ ok: false }, { status: 403 });

  return NextResponse.json({
    ok: true,
    userId: user.id,
    name: user.name,
    spaceId: page.space_id,
  });
}
