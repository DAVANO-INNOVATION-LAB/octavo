import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { isAgent, setSpaceMember } from "@/lib/roles";
import { createPage, createSpace, savePage } from "@/lib/data";
import { markdownToBlocks } from "@/lib/markdown";
import { pageContentToBlocks } from "@/lib/html-blocks";
import { recordAudit } from "@/lib/audit";
import { fetchGuarded } from "@/lib/import-url";

export const runtime = "nodejs";

/**
 * Import a page from a URL: fetch it, find the article, keep the words.
 *
 * This is the one importer that makes the server reach out, so it is fenced:
 * only signed-in people (never agents), only http(s), never private address
 * space — an importer must not become a tool for reading the operator's
 * internal network. Redirects are followed by hand so every hop passes the
 * same fence. The fetched document becomes a new private space with one
 * page; nothing on the fetched page is executed or proxied afterward, and
 * on an air-gapped instance this feature simply fails closed like any other
 * outbound call.
 */

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (isAgent(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: { url?: unknown; name?: unknown };
  try {
    const parsed = await req.json();
    // typeof null === "object", so guard both — a bare `null` body must be a
    // 400, not a 500 from reading `.url` off it.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    body = parsed as { url?: unknown; name?: unknown };
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const raw = String(body.url ?? "").trim();
  if (!raw) return NextResponse.json({ error: "no url" }, { status: 400 });

  let fetched;
  try {
    fetched = await fetchGuarded(raw);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "fetch failed" },
      { status: 400 }
    );
  }

  const isMarkdown =
    /markdown|text\/plain/.test(fetched.contentType) || /\.(md|markdown)([?#]|$)/.test(fetched.finalUrl);
  const converted = isMarkdown
    ? { title: "", blocks: markdownToBlocks(fetched.body) }
    : pageContentToBlocks(fetched.body);

  if (converted.blocks.length === 0)
    return NextResponse.json(
      { error: "nothing readable was found on that page" },
      { status: 422 }
    );

  const title =
    String(body.name ?? "").trim() ||
    converted.title ||
    new URL(fetched.finalUrl).hostname;
  const space = createSpace({
    name: title.slice(0, 120),
    description: `Imported from ${fetched.finalUrl}`.slice(0, 300),
    kind: "docs",
    visibility: "private",
  });
  setSpaceMember(space.id, user.id, "admin");
  const page = createPage({
    spaceId: space.id,
    parentId: null,
    title: title.slice(0, 200),
    content: JSON.stringify(converted.blocks),
  });
  savePage(page.id, { published: true });

  recordAudit({
    actor: user,
    action: "space.created",
    objectType: "space",
    objectId: space.id,
    objectLabel: space.name,
    spaceId: space.id,
    detail: { importedFrom: fetched.finalUrl, blocks: converted.blocks.length },
  });

  return NextResponse.json({ spaceSlug: space.slug, blocks: converted.blocks.length });
}
