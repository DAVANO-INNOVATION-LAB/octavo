import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getPage } from "@/lib/data";
import { startRun } from "@/lib/connectors";

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json()) as {
    pageId?: string;
    blockId?: string;
    connectorId?: string;
    params?: Record<string, unknown>;
  };
  if (!body.pageId || !body.blockId || !body.connectorId)
    return NextResponse.json({ error: "bad request" }, { status: 400 });

  const page = getPage(body.pageId);
  if (!page) return NextResponse.json({ error: "not found" }, { status: 404 });

  const result = await startRun({
    pageId: body.pageId,
    blockId: body.blockId,
    connectorId: body.connectorId,
    spaceId: page.space_id,
    user: { id: user.id, name: user.name },
    params:
      body.params && typeof body.params === "object" ? body.params : {},
  });
  return NextResponse.json(result, { status: result.status === "failed" && !result.runId ? 400 : 200 });
}
