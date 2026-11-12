import { currentUser } from "@/lib/auth";
import { getSpaceBySlug } from "@/lib/data";
import { verifyImportProvenance } from "@/lib/provenance-verification";
import { sameOrigin } from "@/lib/request-origin";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const headers = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
  if (!sameOrigin(req.headers)) return Response.json({ error: "A same-origin request is required." }, { status: 403, headers });
  const { slug } = await params;
  const space = getSpaceBySlug(slug);
  const result = space ? verifyImportProvenance(await currentUser(), space.id) : null;
  if (!result) return Response.json({ error: "Not found" }, { status: 404, headers });
  return Response.json(result, { headers });
}
