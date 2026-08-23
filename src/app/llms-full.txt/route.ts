import { NextRequest } from "next/server";
import { flattenTree, listSpaces, pageTree } from "@/lib/data";
import { pageToMarkdown } from "@/lib/transfer";

export const dynamic = "force-dynamic";

/** Every published page of every public space, inlined as one document. */
export async function GET(req: NextRequest) {
  const origin = process.env.OCTAVO_BASE_URL ?? req.nextUrl.origin;
  const out: string[] = [
    "# Octavo library — full text",
    "",
    "> Every published page of every public space, in reading order.",
    "",
  ];
  for (const space of listSpaces([])) {
    out.push(`# ${space.name}`);
    if (space.description) out.push(`> ${space.description}`, "");
    for (const p of flattenTree(pageTree(space.id, true))) {
      out.push(`## ${p.title}`, `Source: ${origin}/${space.slug}/${p.slug}`, "");
      const md = pageToMarkdown(p.id) ?? "";
      out.push(md.replace(/^---[\s\S]*?---\n+/, ""), "");
    }
  }
  return new Response(out.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
