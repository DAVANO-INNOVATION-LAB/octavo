import { NextRequest } from "next/server";
import { flattenTree, listSpaces, pageTree } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * llms.txt — the index AI agents read. Public spaces only; every page links
 * to its raw Markdown export. About half of documentation reads in 2026 are
 * agents; this is the front door we hold open for them.
 */
export async function GET(req: NextRequest) {
  const origin = process.env.OCTAVO_BASE_URL ?? req.nextUrl.origin;
  const spaces = listSpaces([]);
  const lines: string[] = [
    "# Octavo library",
    "",
    "> Self-hosted documentation. Each page below links to its published",
    "> HTML; append nothing — the .md link beside it is the raw Markdown.",
    "",
  ];
  for (const space of spaces) {
    lines.push(`## ${space.name}`);
    if (space.description) lines.push(`> ${space.description}`);
    lines.push("");
    const pages = flattenTree(pageTree(space.id, true));
    for (const p of pages) {
      lines.push(
        `- [${p.title}](${origin}/${space.slug}/${p.slug}) — [markdown](${origin}/api/pages/${p.id}/export)`
      );
    }
    lines.push("");
  }
  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
