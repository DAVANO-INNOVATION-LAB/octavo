import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { isAgent } from "@/lib/roles";
import { importUpload } from "@/lib/transfer";

const MAX_BYTES = 100 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user)
    return NextResponse.redirect(new URL("/login", req.url), { status: 303 });
  if (isAgent(user))
    return NextResponse.redirect(new URL("/", req.url), { status: 303 });

  const form = await req.formData();
  const file = form.get("file");
  const name = String(form.get("name") ?? "");
  if (!(file instanceof File))
    return NextResponse.redirect(new URL("/import?error=nofile", req.url), {
      status: 303,
    });
  if (file.size > MAX_BYTES)
    return NextResponse.redirect(new URL("/import?error=toolarge", req.url), {
      status: 303,
    });

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const result = importUpload(file.name, buf, name || undefined);
    return NextResponse.redirect(new URL(`/${result.spaceSlug}`, req.url), {
      status: 303,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "import failed";
    return NextResponse.redirect(
      new URL(`/import?error=${encodeURIComponent(msg)}`, req.url),
      { status: 303 }
    );
  }
}
