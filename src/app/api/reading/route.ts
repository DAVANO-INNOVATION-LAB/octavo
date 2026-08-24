import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getPage, getSpace } from "@/lib/data";
import { canReadSpace } from "@/lib/roles";
import { parseBlocks } from "@/lib/blocks";
import { readablePassages, recordReading, readingEnabled } from "@/lib/reading";

/**
 * Where a reader slowed down, doubled back, or stopped.
 *
 * Sent once, when the page is closing. The body carries block ids and
 * durations and nothing else — no identifier is read here and none is
 * stored, because the table it lands in has no column to put one in.
 *
 * The permission check is the same one the page itself uses: if you could
 * not have read the page, your reading of it is not recorded either.
 */
export async function POST(req: NextRequest) {
  if (!readingEnabled())
    return new NextResponse(null, { status: 204 });

  let body: {
    pageId?: unknown;
    blocks?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const page = getPage(String(body.pageId ?? ""));
  if (!page) return new NextResponse(null, { status: 204 });

  const space = getSpace(page.space_id);
  const user = await currentUser();
  if (!space || !canReadSpace(user, space))
    return new NextResponse(null, { status: 204 });

  if (!Array.isArray(body.blocks))
    return NextResponse.json({ error: "bad request" }, { status: 400 });

  const valid = new Set(
    readablePassages(parseBlocks(page.content)).map((p) => p.id)
  );

  const entries = body.blocks
    .filter((b): b is Record<string, unknown> => Boolean(b) && typeof b === "object")
    .map((b) => ({
      id: String(b.id ?? ""),
      dwell: Number(b.dwell ?? 0),
      revisits: Number(b.revisits ?? 0),
      exit: Boolean(b.exit),
    }));

  recordReading(page.id, entries, valid);
  // Nothing to say back. A beacon cannot read a response anyway, and a body
  // here would only be a place for a mistake to leak something.
  return new NextResponse(null, { status: 204 });
}
