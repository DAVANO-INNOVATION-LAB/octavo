import { NextRequest, NextResponse } from "next/server";
import { scopeFor } from "@/lib/roles";
import { currentUser } from "@/lib/auth";
import { recordSearch, searchPages } from "@/lib/data";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const user = await currentUser();
  const params = req.nextUrl.searchParams;
  const days = Number(params.get("days"));
  const results = searchPages(q, scopeFor(user), 12, {
    space: params.get("space") || undefined, kind: params.get("kind") || undefined,
    owner: params.get("owner") === "me" ? user?.id : params.get("owner") || undefined,
    since: days > 0 && days <= 3650 ? Date.now() - days * 86400_000 : undefined,
  });
  // What people search for — and what finds nothing — is the clearest signal
  // of a documentation gap.
  if (q.trim().length > 2) recordSearch(q, results.length);
  return NextResponse.json({ results });
}
