import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { currentUser } from "@/lib/auth";
import { canEditSpace, isAgent } from "@/lib/roles";
import { getSpaceBySlug } from "@/lib/data";
import { recordUpload } from "@/lib/uploads";
import { UPLOADS_DIR } from "@/lib/db";
import { newId } from "@/lib/util";

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov"]);
const EXT_ALLOW = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif",
  ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg",
  ".pdf", ".txt", ".md", ".csv", ".json", ".zip",
]);

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (isAgent(user))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File))
    return NextResponse.json({ error: "no file" }, { status: 400 });

  const ext = path.extname(file.name || "").toLowerCase();
  if (!EXT_ALLOW.has(ext))
    return NextResponse.json({ error: "file type not allowed" }, { status: 415 });
  const limit = VIDEO_EXT.has(ext) ? MAX_VIDEO_BYTES : MAX_BYTES;
  if (file.size > limit)
    return NextResponse.json({ error: "too large" }, { status: 413 });

  const name = `${newId()}${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(path.join(UPLOADS_DIR, name), buf);

  // Record who uploaded it and where. Until the file lands on a page this is
  // the only claim on it, and without a claim nobody but an instance admin
  // could read back the thing they just sent.
  const spaceSlug = String(form.get("space") ?? "").trim();
  const space = spaceSlug ? getSpaceBySlug(spaceSlug) : null;
  recordUpload(name, user.id, space && canEditSpace(user, space.id) ? space.id : null);

  return NextResponse.json({ url: `/api/files/${name}` });
}
