import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getPage, getSpaceBySlug, listPages } from "@/lib/data";
import { canEditSpace } from "@/lib/roles";
import { sameOrigin } from "@/lib/request-origin";

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in to organize pages." }, { status: 401 });
  if (!sameOrigin(req.headers)) return NextResponse.json({ error: "Origin mismatch." }, { status: 403 });
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request." }, { status: 400 }); }
  if (!body || typeof body.space !== "string" || typeof body.pageId !== "string" || !(body.targetId === undefined
      ? ["up", "down"].includes(body.direction)
      : typeof body.targetId === "string" && ["before", "after"].includes(body.placement) && body.direction === undefined))
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const space = getSpaceBySlug(body.space);
  if (!space || !canEditSpace(user, space.id)) return NextResponse.json({ error: "Editing access required." }, { status: 403 });
  const db = getDb();
  const found = db.transaction(() => {
    const page = getPage(body.pageId);
    if (!page || page.space_id !== space.id) return false;
    const siblings = listPages(space.id).filter(p => p.parent_id === page.parent_id);
    const index = siblings.findIndex(p => p.id === page.id);
    if (body.targetId !== undefined) {
      const targetIndex = siblings.findIndex(p => p.id === body.targetId);
      // Never accept another space or parent as a drop destination.
      if (targetIndex < 0) return false;
      if (body.targetId === page.id) return true;
      siblings.splice(index, 1);
      const insertion = siblings.findIndex(p => p.id === body.targetId) + (body.placement === "after" ? 1 : 0);
      siblings.splice(insertion, 0, page);
    } else {
      const target = index + (body.direction === "up" ? -1 : 1);
      if (target < 0 || target >= siblings.length) return true;
      [siblings[index], siblings[target]] = [siblings[target], siblings[index]];
    }
    const update = db.prepare("UPDATE pages SET position = ? WHERE id = ? AND space_id = ?");
    siblings.forEach((p, i) => update.run(i, p.id, space.id));
    return true;
  })();
  if (!found) return NextResponse.json({ error: "Page not found." }, { status: 404 });
  revalidatePath(`/${space.slug}`);
  revalidatePath(`/${space.slug}/organize`);
  revalidatePath("/[space]/[page]", "page");
  return NextResponse.json({ ok: true });
}
