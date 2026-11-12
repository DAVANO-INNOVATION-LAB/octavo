import "server-only";
import path from "node:path";
import { notionId } from "./notion";
import { transformMarkdownUrls } from "./markdown-assets";

export type MarkdownPageDestination = { sourcePath: string; href: string };

/** Rewrite parsed page links against destinations that actually exist. Archive
 * paths remain distinct from display names and generated page slugs. */
export function createMarkdownPageLinkRewriter(
  destinations: MarkdownPageDestination[],
  allowNotionIds = false
): <T extends unknown[]>(blocks: T, sourcePath: string) => T {
  const paths = new Map(destinations.map(d => [path.posix.normalize(d.sourcePath), d.href]));
  const ids = new Map<string,string|null>();
  if (allowNotionIds) for (const destination of destinations) {
    const id = notionId(destination.sourcePath);
    if (id) ids.set(id,ids.has(id)?null:destination.href);
  }
  return <T extends unknown[]>(blocks: T, sourcePath: string): T => transformMarkdownUrls(blocks,url => {
    if (!url || /^(?:#|\/|[a-z][a-z0-9+.-]*:)/i.test(url)) return url;
    const boundary=url.search(/[?#]/),raw=boundary<0?url:url.slice(0,boundary);
    let decoded:string;try{decoded=decodeURIComponent(raw);}catch{return url;}
    if (!/\.md$/i.test(decoded) || decoded.includes("\0") || decoded.includes("\\") || decoded.startsWith("/") || /^[a-z]:/i.test(decoded)) return url;
    const target=path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath),decoded));
    if(target===".."||target.startsWith("../"))return url;
    const href=paths.get(target) ?? (allowNotionIds ? ids.get(notionId(decoded)) : undefined);
    return href ? href+(boundary<0?"":url.slice(boundary)) : url;
  });
}

/** Convenience wrapper for individual documents; bulk imports share one rewriter. */
export function rewriteMarkdownPageLinks<T extends unknown[]>(
  blocks: T,
  sourcePath: string,
  destinations: MarkdownPageDestination[],
  allowNotionIds = false
): T {
  return createMarkdownPageLinkRewriter(destinations,allowNotionIds)(blocks,sourcePath);
}
