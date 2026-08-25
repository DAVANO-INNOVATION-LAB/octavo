import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getPage, getSpace } from "@/lib/data";
import { canReadSpace } from "@/lib/roles";
import { getDb } from "@/lib/db";
import { newId, now } from "@/lib/util";

/**
 * A reader's own highlights. Every query here is scoped to the signed-in
 * user — there is no route, parameter, or role that returns someone else's.
 * The permission to highlight a page is exactly the permission to read it.
 */

export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ highlights: [] });
  const pageId = req.nextUrl.searchParams.get("page") ?? "";
  const rows = getDb()
    .prepare(
      "SELECT id, block_id, text, note, created_at FROM highlights WHERE user_id = ? AND page_id = ? ORDER BY created_at"
    )
    .all(user.id, pageId);
  return NextResponse.json({ highlights: rows });
}

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { pageId?: unknown; blockId?: unknown; text?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const page = getPage(String(body.pageId ?? ""));
  if (!page) return NextResponse.json({ error: "not found" }, { status: 404 });
  const space = getSpace(page.space_id);
  if (!space || !canReadSpace(user, space))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const text = String(body.text ?? "").trim().slice(0, 2000);
  const blockId = String(body.blockId ?? "");
  if (!text || !blockId)
    return NextResponse.json({ error: "bad request" }, { status: 400 });

  // The same passage marked twice is one highlight, not two.
  const existing = getDb()
    .prepare(
      "SELECT id FROM highlights WHERE user_id = ? AND page_id = ? AND block_id = ? AND text = ?"
    )
    .get(user.id, page.id, blockId, text) as { id: string } | undefined;
  if (existing) return NextResponse.json({ id: existing.id });

  const id = newId();
  getDb()
    .prepare(
      "INSERT INTO highlights (id, user_id, page_id, block_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(id, user.id, page.id, blockId, text, now());
  return NextResponse.json({ id });
}

export async function DELETE(req: NextRequest) {
  const user = await currentUser();
  if (!user)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id") ?? "";
  // Deleting is scoped by user in the WHERE clause itself, so guessing ids
  // removes nothing that is not yours.
  getDb()
    .prepare("DELETE FROM highlights WHERE id = ? AND user_id = ?")
    .run(id, user.id);
  return new NextResponse(null, { status: 204 });
}
