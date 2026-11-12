import { importIdempotencyKey, importRequestFingerprint, replayImport, recordImport } from "@/lib/import-idempotency";
import { sameOrigin } from "@/lib/request-origin";
import { createImportReport } from "@/lib/import-reports";
import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getSpaceBySlug } from "@/lib/data";
import { revalidatePath } from "next/cache";
import { isAgent, setSpaceMember } from "@/lib/roles";
import { previewImport } from "@/lib/import-preview";
import { attributeImportAttachments, runImportTransaction } from "@/lib/import-transaction";
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

  if (req.headers.get("origin") && !sameOrigin(req.headers)) return localRedirect("/import?error=origin-mismatch");

  const form = await req.formData();
  const file = form.get("file");
  const name = String(form.get("name") ?? "");
  if (!(file instanceof File))
    return localRedirect("/import?error=nofile");
  if (file.size > MAX_BYTES)
    return localRedirect("/import?error=toolarge");

  let spaceSlug: string;
  let replayed = false;
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const key = importIdempotencyKey(form);
    const fingerprint = key ? importRequestFingerprint(file.name, buf, name) : null;
    // A short completed-request probe avoids reconverting a known retry. New
    // requests preview without holding SQLite's write lock, then recheck under
    // the immediate transaction so a concurrent winner is still reused.
    const previous = key && fingerprint ? runImportTransaction(() => replayImport(user,key,fingerprint)) : null;
    if (previous) {
      spaceSlug = previous;
      replayed = true;
    } else {
      const preview = previewImport(file.name, buf);
      const digest = form.get("previewDigest");
      if (digest && digest !== preview.digest) throw new Error("The file changed after preview; preview it again");
      if (preview.errors.length) throw new Error(preview.errors.join("; "));
      spaceSlug = runImportTransaction(() => {
        if (key && fingerprint) {
          const winner = replayImport(user,key,fingerprint);
          if (winner) { replayed = true; return winner; }
        }
        const result = importUpload(file.name, buf, name || undefined);
        const space = getSpaceBySlug(result.spaceSlug);
        if (!space) throw new Error("Imported space was not found");
        setSpaceMember(space.id, user.id, "admin");
        attributeImportAttachments(space.id, user.id);
        createImportReport({spaceId:space.id,actorId:user.id,sourceKind:"upload",sourceLabel:file.name,sourceBytes:buf,preview:{pages:preview.pages.length,attachmentEntries:preview.attachments,warnings:preview.warnings,...(preview.assetPlan?{assetPlan:preview.assetPlan}:{})}});
        if (key && fingerprint) recordImport(user.id, key, fingerprint, space.id);
        return space.slug;
      });
    }
  } catch (e) {
    if (e instanceof AggregateError) console.error("Import rollback needs operator attention", e);
    const msg = e instanceof Error ? e.message : "import failed";
    return localRedirect(`/import?error=${encodeURIComponent(msg)}`);
  }
  // Content and ownership are committed. A cache error must not imply rollback
  // or encourage the user to import the same content again.
  try {
    revalidatePath("/");
    revalidatePath(`/${spaceSlug}`);
  } catch (error) {
    console.error("Import committed; cache revalidation failed", error);
  }
  return localRedirect(`/${spaceSlug}${replayed ? "?importReplayed=1" : ""}`);
}
