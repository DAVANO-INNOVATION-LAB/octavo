import { createHash } from "node:crypto";
import { extractHeadings, parseBlocks } from "./blocks";

export type Reference = { kind: "link" | "asset" | "synced"; value: string };
/** Includes links inside table cells and media props, not just paragraphs. */
export function documentReferences(content: string): Reference[] {
  const out: Reference[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    const x = value as Record<string, unknown>;
    if (typeof x.href === "string") out.push({ kind: "link", value: x.href });
    if (typeof x.url === "string" && x.url) out.push({ kind: "asset", value: x.url });
    if (x.type === "syncedPage" && x.props && typeof x.props === "object") {
      const id = (x.props as Record<string, unknown>).pageId;
      if (typeof id === "string" && id) out.push({ kind: "synced", value: id });
    }
    Object.values(x).forEach(visit);
  };
  try { visit(JSON.parse(content)); } catch { return []; }
  return [...new Map(out.map(r => [`${r.kind}:${r.value}`, r])).values()];
}

export function contentDigest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function missingSections(content: string, required: string[]): string[] {
  const headings = new Set(extractHeadings(parseBlocks(content)).map(h => h.text.trim().toLowerCase()));
  return required.filter(h => h.trim() && !headings.has(h.trim().toLowerCase()));
}

export function reviewDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Choose a valid review date");
  const t = Date.parse(`${value}T23:59:59.999Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== value) throw new Error("Choose a valid review date");
  return t;
}

/** Compare complete blocks; diagrams, tables and media changes remain visible. */
export function readableBlocks(content: string): string {
  return JSON.stringify(parseBlocks(content), (key, value) => key === "id" ? undefined : value, 2);
}
