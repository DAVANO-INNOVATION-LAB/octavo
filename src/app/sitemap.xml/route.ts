import { NextRequest } from "next/server";
import { flattenTree, listSpaces, pageTree } from "@/lib/data";

export const dynamic = "force-dynamic";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function GET(req: NextRequest) {
  const origin = (process.env.OCTAVO_BASE_URL ?? req.nextUrl.origin).replace(/\/$/, "");
  const urls: string[] = [`  <url><loc>${esc(origin)}/</loc></url>`];
  for (const space of listSpaces([])) {
    urls.push(
      `  <url><loc>${esc(`${origin}/${space.slug}`)}</loc><lastmod>${new Date(space.updated_at).toISOString()}</lastmod></url>`
    );
    for (const p of flattenTree(pageTree(space.id, true))) {
      urls.push(
        `  <url><loc>${esc(`${origin}/${space.slug}/${p.slug}`)}</loc><lastmod>${new Date(p.updated_at).toISOString()}</lastmod></url>`
      );
    }
  }
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`,
    { headers: { "Content-Type": "application/xml; charset=utf-8" } }
  );
}
