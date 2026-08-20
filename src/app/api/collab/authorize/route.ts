import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getPage } from "@/lib/data";
import { may } from "@/lib/roles";
import { claimSeed } from "@/lib/collab-seed";

/**
 * Whether the caller may co-edit a page, and whether they are the one who
 * should seed the shared document.
 *
 * The collaboration server runs outside the Next bundle — it is attached to
 * the same HTTP listener so co-editing needs no second port — and it must not
 * carry its own copy of the permission rules. Both it and the browser ask
 * here, so the capability matrix is consulted in one place and cannot drift.
 *
 * Seeding is claimed atomically. Two people opening a page that has never
 * been co-edited would otherwise both find an empty document and both insert
 * the page's contents, and the reader would get everything twice.
 */
export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  const pageId = req.nextUrl.searchParams.get("page") ?? "";
  const page = getPage(pageId);
  if (!page) return NextResponse.json({ ok: false }, { status: 404 });

  if (!may(user, page.space_id, "write"))
    return NextResponse.json({ ok: false }, { status: 403 });

  // Only claim when the browser asks; the socket's own check must not consume
  // the claim, or the client that needs it would never receive it.
  const wantsSeed = req.nextUrl.searchParams.get("claim") === "1";

  return NextResponse.json({
    ok: true,
    userId: user.id,
    name: user.name,
    spaceId: page.space_id,
    seed: wantsSeed ? claimSeed(pageId) : false,
  });
}
