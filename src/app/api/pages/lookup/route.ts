import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { lookupPages } from "@/lib/data";
import { readablePrivateSpaceIds } from "@/lib/roles";

export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const q = req.nextUrl.searchParams.get("q") ?? "";
  return NextResponse.json({ pages: lookupPages(q, readablePrivateSpaceIds(user)) });
}
