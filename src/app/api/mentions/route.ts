import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { mentionableUsers } from "@/lib/data";

/** Names the comment box can offer after an "@". Signed-in callers only. */
export async function GET() {
  const user = await currentUser();
  if (!user)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ users: mentionableUsers() });
}
