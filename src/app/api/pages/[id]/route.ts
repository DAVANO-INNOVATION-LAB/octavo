import { collaborationEnabled } from "@/lib/collab-config";
import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getPage } from "@/lib/data";
import { pageRevision, savePageAtRevision, PageRevisionConflict } from "@/lib/page-revisions";
import { getDb } from "@/lib/db";
import { savePage } from "@/lib/data";
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
  let body: { title?: unknown; content?: unknown; expectedRevision?: unknown; expectedEpoch?: unknown; expectedTitle?:unknown };
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    body = parsed as typeof body;
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
  if (collaborationEnabled()) {
    const db = getDb();
    if (fields.content !== undefined && (db.prepare("SELECT 1 FROM collab_docs WHERE page_id=?").get(id) ||
        db.prepare("SELECT 1 FROM collab_room_leases WHERE page_id=? AND expires_at>?").get(id,Date.now())))
      return NextResponse.json({error:"Shared body must be saved through collaboration",current:pageRevision(id)},{status:409});
    if (fields.content === undefined && typeof fields.title === "string" && body.expectedTitle !== undefined) {
      if (typeof body.expectedTitle !== "string" || !Number.isSafeInteger(body.expectedEpoch) || Number(body.expectedEpoch)<0)
        return NextResponse.json({error:"invalid metadata version"},{status:400});
      const result = db.transaction(() => {
        const current = getPage(id), version = pageRevision(id);
        if (!current || current.title !== body.expectedTitle || version.epoch !== body.expectedEpoch) return null;
        const saved = savePage(id,{title:fields.title,by:user.id})!;
        return {ok:true,title:saved.title,slug:saved.slug,updated_at:saved.updated_at,...pageRevision(id)};
      }).immediate();
      return result ? NextResponse.json(result) : NextResponse.json({error:"Title or epoch changed; preserve your draft",current:pageRevision(id)},{status:409});
    }
  }
  if (body.expectedRevision === undefined)
    return NextResponse.json({ error: "expected revision required", current: pageRevision(id) }, { status: 428 });
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0 ||
      (body.expectedEpoch !== undefined && (!Number.isSafeInteger(body.expectedEpoch) || Number(body.expectedEpoch) < 0)))
    return NextResponse.json({ error: "invalid revision" }, { status: 400 });
  try {
    // The read, comparison, mutation and returned revision share one transaction.
    const saved = savePageAtRevision(id, { ...fields, by: user.id }, Number(body.expectedRevision),
      body.expectedEpoch === undefined ? undefined : Number(body.expectedEpoch));
    return NextResponse.json({ ok: true, slug: saved.slug, updated_at: saved.updated_at,
      revision: saved.revision, epoch: saved.epoch });
  } catch (error) {
    if (error instanceof PageRevisionConflict)
      return NextResponse.json({ error: "page changed; preserve your draft and reload before reconciling", current: error.current }, { status: 409 });
    throw error;
  }
}
