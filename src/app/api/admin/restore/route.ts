import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getDb, DATA_DIR } from "@/lib/db";
import { RestoreError, restoreSnapshot } from "@/lib/restore";

const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

declare global {
  var __octavoRestoreInProgress: boolean | undefined;
}

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user || user.role !== "admin")
    return NextResponse.redirect(new URL("/login", req.url), { status: 303 });

  const fail = (why: string) => NextResponse.redirect(
    new URL(`/admin/backups?error=${encodeURIComponent(why)}`, req.url), { status: 303 }
  );
  // The standalone collaboration server owns another connection and cached rooms.
  // Require an explicit maintenance restart rather than swapping under that handle.
  if (process.env.OCTAVO_COLLAB !== "0")
    return fail("restart Octavo with OCTAVO_COLLAB=0 before restoring; re-enable collaboration after restore");
  if (globalThis.__octavoRestoreInProgress) return fail("another restore is already in progress");
  globalThis.__octavoRestoreInProgress = true;
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (String(form.get("confirm") ?? "") !== "REPLACE") return fail("type REPLACE to confirm");
    if (!(file instanceof File)) return fail("choose a snapshot file");
    if (file.size > MAX_BYTES) return fail("file is too large");
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length > MAX_BYTES) return fail("file is too large");
    restoreSnapshot(bytes, DATA_DIR, getDb, () => { globalThis.__octavoDb = undefined; });
    const res = NextResponse.redirect(new URL("/admin/backups?restored=1", req.url), { status: 303 });
    res.cookies.delete("octavo_session");
    return res;
  } catch (error) {
    console.error("Database restore failed", error);
    if (error instanceof RestoreError) return fail(error.message);
    return fail("restore failed; the outgoing database was preserved. Check server logs before retrying");
  } finally {
    globalThis.__octavoRestoreInProgress = false;
  }
}
