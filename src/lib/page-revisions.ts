import "server-only";
import { getDb } from "./db";
import { getPage, savePage } from "./data";

export type PageRevision = { revision: number; epoch: number };
export function pageRevision(pageId: string): PageRevision {
  const row = getDb().prepare("SELECT revision,epoch FROM page_edit_versions WHERE page_id=?").get(pageId) as PageRevision | undefined;
  if (!row) throw new Error("Page revision is unavailable");
  return row;
}
export class PageRevisionConflict extends Error {
  constructor(public current: PageRevision) { super("Page changed since it was loaded; local edits were not applied"); }
}
/** Database comparison and write are one transaction. Callers must preserve any
 * rejected client draft and must never retry against a new revision blindly. */
export function savePageAtRevision(
  pageId: string,
  fields: Parameters<typeof savePage>[1],
  expectedRevision: number,
  expectedEpoch?: number,
) {
  return getDb().transaction(() => {
    const current = pageRevision(pageId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || current.revision !== expectedRevision ||
        (expectedEpoch !== undefined && (!Number.isSafeInteger(expectedEpoch) || current.epoch !== expectedEpoch)))
      throw new PageRevisionConflict(current);
    const saved = savePage(pageId,fields);
    if (!saved || !getPage(pageId)) throw new Error("Page disappeared");
    return {...saved,...pageRevision(pageId)};
  })();
}
