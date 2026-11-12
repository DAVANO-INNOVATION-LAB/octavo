import "server-only";
import path from "node:path";
import type { ZipEntry } from "./zip";
import { writeImportAttachment } from "./import-transaction";
import { newId } from "./util";

export const MARKDOWN_ASSET_LIMITS = { perFile: 20 * 1024 * 1024, totalBytes: 100 * 1024 * 1024, files: 1000 } as const;
export type MarkdownAssetDocument = { sourcePath: string; blocks: unknown[] };
export type MarkdownAssetPlan = { assets: Map<string, Buffer>; written: Map<string, string>; bytes: number };

function archivePath(name: string): string {
  if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[a-z]:/i.test(name) || name.split("/").includes("..")) throw new Error("Unsafe Markdown archive path");
  const normalized = path.posix.normalize(name);
  if (normalized === "." || normalized.startsWith("../")) throw new Error("Unsafe Markdown archive path");
  return normalized;
}

function localReference(sourcePath: string, value: string): { target: string; suffix: string } | null {
  if (!value || /^(?:#|\/|[a-z][a-z0-9+.-]*:)/i.test(value)) return null;
  const boundary = value.search(/[?#]/);
  const raw = boundary < 0 ? value : value.slice(0,boundary);
  const suffix = boundary < 0 ? "" : value.slice(boundary);
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  if (!decoded) return null;
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.startsWith("/") || /^[a-z]:/i.test(decoded)) throw new Error("Unsafe Markdown asset reference");
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(archivePath(sourcePath)),decoded));
  if (target === ".." || target.startsWith("../") || target.startsWith("/")) throw new Error("Markdown asset reference escapes archive root");
  // Page linking remains the Markdown/Notion importer's responsibility.
  if (/\.(?:md|markdown)$/i.test(target)) return null;
  return {target,suffix};
}

/** Visit only document URL fields, including nested blocks and table cells. */
function visit(value: unknown, rewrite: (url:string)=>string): void {
  if (Array.isArray(value)) { for(const item of value) visit(item,rewrite); return; }
  if (!value || typeof value !== "object") return;
  const node=value as Record<string,unknown>;
  if (node.type === "link" && typeof node.href === "string") node.href=rewrite(node.href);
  if (node.props && typeof node.props === "object" && !Array.isArray(node.props)) {
    const props=node.props as Record<string,unknown>;
    if(typeof props.url === "string") props.url=rewrite(props.url);
  }
  for(const key of ["content","children","rows","cells"]) if(node[key]) visit(node[key],rewrite);
}

/** Clone and transform only parsed URL positions; never rewrite prose/code. */
export function transformMarkdownUrls<T extends unknown[]>(blocks: T, rewrite: (url: string) => string): T {
  const result=structuredClone(blocks);visit(result,rewrite);return result;
}

/** Pure planning: validate the archive and all referenced copies before writing bytes. */
export function planMarkdownAssets(entries: ZipEntry[], documents: MarkdownAssetDocument[]): MarkdownAssetPlan {
  const index=new Map<string,Buffer>();
  for(const entry of entries){
    const key=archivePath(entry.name);
    if(index.has(key))throw new Error("Ambiguous duplicate Markdown archive path");
    index.set(key,entry.data);
  }
  const plan:MarkdownAssetPlan={assets:new Map(),written:new Map(),bytes:0};
  for(const doc of documents){
    // Walk a clone: preview/planning never changes the caller's blocks.
    visit(structuredClone(doc.blocks),url=>{
      const ref=localReference(doc.sourcePath,url),data=ref?index.get(ref.target):undefined;
      if(!ref||!data||plan.assets.has(ref.target))return url;
      if(data.length>MARKDOWN_ASSET_LIMITS.perFile)throw new Error("Markdown attachment exceeds 20 MiB limit");
      if(plan.assets.size>=MARKDOWN_ASSET_LIMITS.files)throw new Error("Markdown attachments exceed 1000 file limit");
      if(plan.bytes+data.length>MARKDOWN_ASSET_LIMITS.totalBytes)throw new Error("Markdown attachments exceed 100 MiB total limit");
      plan.assets.set(ref.target,data);plan.bytes+=data.length;
      return url;
    });
  }
  return plan;
}

// Only types already supported safely by the files endpoint retain an extension.
const SAFE_EXTENSIONS=new Set(["png","jpg","jpeg","gif","webp","avif","svg","pdf","txt","csv","tsv","json","mp4","webm","mp3","ogg","wav","zip"]);
export function rewriteMarkdownAssets<T extends unknown[]>(blocks: T, sourcePath: string, plan: MarkdownAssetPlan): T {
  const rewritten=structuredClone(blocks);
  visit(rewritten,url=>{
    const ref=localReference(sourcePath,url);
    if(!ref||!plan.assets.has(ref.target))return url;
    let replacement=plan.written.get(ref.target);
    if(!replacement){
      const original=path.posix.extname(ref.target).slice(1).toLowerCase();
      const extension=SAFE_EXTENSIONS.has(original)?original:"bin";
      const name=`${newId()}.${extension}`;
      writeImportAttachment(name,plan.assets.get(ref.target)!);
      replacement=`/api/files/${name}`;plan.written.set(ref.target,replacement);
    }
    return replacement+ref.suffix;
  });
  return rewritten;
}
