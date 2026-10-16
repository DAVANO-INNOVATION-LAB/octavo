import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getSpaceBySlug } from "@/lib/data";
import { revalidatePath } from "next/cache";
import { isAgent, setSpaceMember } from "@/lib/roles";
import { importUpload } from "@/lib/transfer";

// Keep the browser on its public origin, including behind container proxies.
function localRedirect(path: string) {
  return new NextResponse(null, { status: 303, headers: { Location: path } });
}

const MAX_BYTES = 100 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user)
    return localRedirect("/login");
  if (isAgent(user))
    return localRedirect("/");

  const form = await req.formData();
  const file = form.get("file");
  const name = String(form.get("name") ?? "");
  if (!(file instanceof File))
    return localRedirect("/import?error=nofile");
  if (file.size > MAX_BYTES)
    return localRedirect("/import?error=toolarge");

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const result = importUpload(file.name, buf, name || undefined);
    const space = getSpaceBySlug(result.spaceSlug);
    if (!space) throw new Error("Imported space was not found");
    setSpaceMember(space.id, user.id, "admin");
    revalidatePath("/");
    revalidatePath(`/${space.slug}`);
    return localRedirect(`/${result.spaceSlug}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "import failed";
    return localRedirect(`/import?error=${encodeURIComponent(msg)}`);
  }
}
