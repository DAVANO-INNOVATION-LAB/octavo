import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { canReadSpace } from "@/lib/roles";
import { getSpaceBySlug } from "@/lib/data";
import { architectureScene, pipelineScene } from "@/lib/model-source";

/**
 * A space's own scene, so the editor can preview a derived model.
 *
 * Derivation stays on the server: the scene is built from pages and runs,
 * and handing that to the browser unchecked would let anyone read a space's
 * structure. The same read permission that guards the space guards this.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const space = getSpaceBySlug(slug);
  if (!space) return new NextResponse("not found", { status: 404 });

  const user = await currentUser();
  if (!canReadSpace(user, space))
    return new NextResponse("unauthorized", { status: 401 });

  const kind = req.nextUrl.searchParams.get("kind") ?? "architecture";
  const scene = kind === "pipeline" ? pipelineScene(space.id) : architectureScene(space.id);
  return NextResponse.json(scene, {
    headers: { "Cache-Control": "no-store" },
  });
}
