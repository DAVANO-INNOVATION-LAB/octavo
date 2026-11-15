import { collaborationEnabled } from "@/lib/collab-config";
import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getPage } from "@/lib/data";
import { may } from "@/lib/roles";
import { getDb } from "@/lib/db";
import { pageRevision } from "@/lib/page-revisions";

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

  if (!collaborationEnabled()) return NextResponse.json({ok:false,error:"Collaboration is disabled"},{status:503});
  // Plain Next launchers have no WebSocket coordinator. Never claim a seed or
  // advertise barriers unless the wrapper installed its private capability.
  if (!process.env.OCTAVO_COLLAB_INTERNAL_SECRET)
    return NextResponse.json({ok:false,error:"Collaboration coordinator is unavailable"},{status:503});
  const projector = await import("@/lib/collab-projection");
  const snapshot = getDb().transaction(() => {
    const current = getPage(pageId);
    if (!current) return null;
    const version = pageRevision(pageId);
    if (projector) {
      const previous = getDb().prepare("SELECT state FROM collab_docs WHERE page_id=?").get(pageId) as {state:Buffer}|undefined;
      if (previous?.state.length) {
        // Existing installations may contain unprojected shared edits or an
        // independently changed page. Never silently choose one as the winner.
        const sharedContent = projector.projectSharedState(previous.state);
        const pageContent = projector.projectSharedState(projector.seedSharedState(current.content));
        if (sharedContent !== pageContent) return {ok:false,error:"Shared document and page differ; recovery review required"};
      }
      if (!previous || !previous.state.length) {
        // A live old-protocol seed must not be replaced underneath its editor.
        if (getDb().prepare("SELECT 1 FROM collab_room_leases WHERE page_id=? AND expires_at>?").get(pageId,Date.now()))
          return {ok:false,error:"Shared seed is still active"};
        const state = projector.seedSharedState(current.content);
        getDb().prepare(`INSERT INTO collab_docs(page_id,state,updated_at) VALUES(?,?,?)
          ON CONFLICT(page_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at`)
          .run(pageId,Buffer.from(state),Date.now());
      }
    }
    return {
      ok: true, userId:user.id, name:user.name, spaceId:current.space_id,
      ...version, seed:false,
      persistence:"barrier-v1",
      ...(wantsSeed ? {content:current.content} : {}),
    };
  })();
  return snapshot ? NextResponse.json(snapshot,{status:snapshot.ok ? 200 : 409}) : NextResponse.json({ok:false},{status:404});
}
