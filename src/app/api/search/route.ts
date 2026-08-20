import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { searchPages } from "@/lib/data";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const user = await currentUser();
  return NextResponse.json({ results: searchPages(q, Boolean(user)) });
}
