import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

type Entry = { slug: string; shelf: string };

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json()) as { order?: unknown };
  if (
    !Array.isArray(body.order) ||
    body.order.some(
      (e) =>
        typeof e !== "object" ||
        e === null ||
        typeof (e as Entry).slug !== "string" ||
        typeof (e as Entry).shelf !== "string"
    )
  )
    return NextResponse.json({ error: "bad payload" }, { status: 400 });

  const db = getDb();
  const set = db.prepare(
    "UPDATE spaces SET position = ?, shelf = ? WHERE slug = ?"
  );
  const apply = db.transaction((order: Entry[]) => {
    order.forEach((e, i) =>
      set.run((i + 1) * 10, e.shelf.trim().slice(0, 40), e.slug)
    );
  });
  apply(body.order as Entry[]);
  return NextResponse.json({ ok: true });
}
