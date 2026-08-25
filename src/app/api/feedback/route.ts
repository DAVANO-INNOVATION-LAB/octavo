import { NextRequest, NextResponse } from "next/server";
import { getPage, recordFeedback } from "@/lib/data";

export async function POST(req: NextRequest) {
  let body: { pageId?: string; helpful?: boolean; note?: string };
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object")
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    body = parsed as { pageId?: string; helpful?: boolean; note?: string };
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (!body.pageId || typeof body.helpful !== "boolean")
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  const page = getPage(body.pageId);
  if (!page || page.published === 0)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  recordFeedback(body.pageId, body.helpful, typeof body.note === "string" ? body.note : "");
  return NextResponse.json({ ok: true });
}
