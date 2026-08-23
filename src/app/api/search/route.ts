import { NextRequest, NextResponse } from "next/server";
import { readablePrivateSpaceIds } from "@/lib/roles";
import { currentUser } from "@/lib/auth";
import { recordSearch, searchPages } from "@/lib/data";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const user = await currentUser();
  const results = searchPages(q, readablePrivateSpaceIds(user));
  // What people search for — and what finds nothing — is the clearest signal
  // of a documentation gap.
  if (q.trim().length > 2) recordSearch(q, results.length);
  return NextResponse.json({ results });
}
