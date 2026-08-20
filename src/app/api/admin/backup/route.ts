import { NextResponse } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { currentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

export async function GET() {
  const user = await currentUser();
  if (!user || user.role !== "admin")
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // SQLite's own backup API: consistent even while writes continue.
  const stamp = new Date().toISOString().slice(0, 10);
  const tmp = path.join(os.tmpdir(), `octavo-backup-${Date.now()}.db`);
  await getDb().backup(tmp);
  const buf = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.sqlite3",
      "Content-Disposition": `attachment; filename="octavo-${stamp}.db"`,
      "Content-Length": String(buf.length),
      "Cache-Control": "no-store",
    },
  });
}
