import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { addComment, getPage } from "@/lib/data";
import { may } from "@/lib/roles";

/**
 * Start a thread on a block, from the editor.
 *
 * The reader's own reply and resolve controls are plain form posts; this
 * exists because the editor is a client surface with the block already in
 * hand, and sending the author to another page to say one sentence about a
 * paragraph they are looking at would not be worth the interruption.
 */
export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let payload: {
    pageId?: string;
    blockId?: string;
    anchorText?: string;
    body?: string;
  };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const pageId = String(payload.pageId ?? "");
  const body = String(payload.body ?? "");
  if (!pageId || !body.trim())
    return NextResponse.json({ error: "bad request" }, { status: 400 });

  // Anchor to a page that exists; a thread on nothing is a thread nobody finds.
  const page = getPage(pageId);
  if (!page)
    return NextResponse.json({ error: "no such page" }, { status: 404 });
  if (!may(user, page.space_id, "comment"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const id = addComment(pageId, user.id, body, {
    blockId: String(payload.blockId ?? ""),
    anchorText: String(payload.anchorText ?? ""),
  });
  if (!id) return NextResponse.json({ error: "empty" }, { status: 400 });

  return NextResponse.json({ id });
}
