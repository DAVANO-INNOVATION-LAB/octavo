import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { isAgent } from "@/lib/roles";
import { createPage, createSpace, savePage } from "@/lib/data";
import { markdownToBlocks } from "@/lib/markdown";
import { pageContentToBlocks } from "@/lib/html-blocks";
import { recordAudit } from "@/lib/audit";

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

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_HOPS = 3;

function blockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
  const ip = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

async function fetchGuarded(rawUrl: string): Promise<{ body: string; finalUrl: string; contentType: string }> {
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("only http and https URLs can be imported");
    if (blockedHost(url.hostname))
      throw new Error("that address is inside private address space");

    const res = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": "octavo-importer", Accept: "text/html, text/markdown, text/plain" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`redirect without a destination (HTTP ${res.status})`);
      url = new URL(loc, url);
      continue;
    }
    if (!res.ok) throw new Error(`the page answered HTTP ${res.status}`);

    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) throw new Error("the page is larger than 5MB");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error("the page is larger than 5MB");
    return {
      body: buf.toString("utf8"),
      finalUrl: url.toString(),
      contentType: res.headers.get("content-type") ?? "",
    };
  }
  throw new Error("too many redirects");
}

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (isAgent(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: { url?: unknown; name?: unknown };
  try {
    body = await req.json();
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
