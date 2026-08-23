import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { canReadSpace } from "@/lib/roles";
import { getSpaceBySlug } from "@/lib/data";
import { exportSpaceZip } from "@/lib/transfer";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const space = getSpaceBySlug(slug);
  if (!space) return new NextResponse("not found", { status: 404 });

  const user = await currentUser();
  if (!canReadSpace(user, space))
    return new NextResponse("unauthorized", { status: 401 });

  const buf = exportSpaceZip(space);
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${space.slug}.zip"`,
      "Content-Length": String(buf.length),
    },
  });
}
