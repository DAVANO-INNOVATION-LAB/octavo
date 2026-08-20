import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { UPLOADS_DIR } from "@/lib/db";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".zip": "application/zip",
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  // Uploaded names are generated ids — reject anything else.
  if (!/^[0-9a-z]+\.[0-9a-z]+$/.test(name))
    return new NextResponse("not found", { status: 404 });
  const file = path.join(UPLOADS_DIR, name);
  if (!fs.existsSync(file)) return new NextResponse("not found", { status: 404 });

  const ext = path.extname(name);
  const size = fs.statSync(file).size;
  const baseHeaders: Record<string, string> = {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
    // Never render uploaded SVG/HTML-ish content inline from our origin.
    ...(ext === ".svg" ? { "Content-Disposition": "attachment" } : {}),
  };

  // Range requests — video/audio seeking depends on this.
  const range = req.headers.get("range");
  if (range) {
    const m = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!m || (m[1] === "" && m[2] === ""))
      return new NextResponse("bad range", { status: 416 });
    const start = m[1] === "" ? Math.max(0, size - Number(m[2])) : Number(m[1]);
    const end = m[1] !== "" && m[2] !== "" ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end)
      return new NextResponse("bad range", {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    const stream = fs.createReadStream(file, { start, end });
    return new NextResponse(stream as unknown as ReadableStream, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }

  const stream = fs.createReadStream(file);
  return new NextResponse(stream as unknown as ReadableStream, {
    headers: { ...baseHeaders, "Content-Length": String(size) },
  });
}
