import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getPage } from "@/lib/data";
import { createChangeRequest } from "@/lib/change-requests";
import { recordAudit } from "@/lib/audit";

/** Submit a proposed edit. The editor holds the document, so it posts it. */
export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: {
    pageId?: string;
    title?: string;
    description?: string;
    proposedTitle?: string;
    proposedContent?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const page = getPage(String(body.pageId ?? ""));
  if (!page) return NextResponse.json({ error: "no such page" }, { status: 404 });
  if (!Array.isArray(body.proposedContent))
    return NextResponse.json({ error: "bad content" }, { status: 400 });

  const cr = createChangeRequest({
    pageId: page.id,
    authorId: user.id,
    title: String(body.title ?? ""),
    description: String(body.description ?? ""),
    proposedTitle: String(body.proposedTitle ?? page.title),
    proposedContent: JSON.stringify(body.proposedContent),
  });
  if (!cr) return NextResponse.json({ error: "failed" }, { status: 500 });

  recordAudit({
    actor: user,
    action: "cr.created",
    objectType: "change_request",
    objectId: cr.id,
    objectLabel: cr.title,
    spaceId: page.space_id,
    detail: { page: page.title },
  });
  return NextResponse.json({ id: cr.id });
}
