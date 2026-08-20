import "server-only";
import { getDb } from "./db";
import { newId, now } from "./util";
import { getPage, savePage } from "./data";

/**
 * Change requests: a proposed edit to a page that someone else reviews before
 * it lands.
 *
 * A request stores the whole proposed document rather than a patch. Pages are
 * small, and a stored patch has to be rebased every time the page moves
 * underneath it — whereas a stored document can always be shown, always be
 * diffed against whatever the page says now, and never becomes unreadable.
 *
 * `base_updated_at` records what the page looked like when the work started.
 * If the page has moved since, the request is stale: it can still be read and
 * discussed, but merging it would silently discard whatever landed in
 * between, so the merge is blocked until the author looks.
 */

export type CrStatus = "open" | "merged" | "closed";
export type Verdict = "approve" | "changes";

export type ChangeRequest = {
  id: string;
  page_id: string;
  author_id: string;
  title: string;
  description: string;
  status: CrStatus;
  proposed_title: string;
  proposed_content: string;
  base_updated_at: number;
  created_at: number;
  updated_at: number;
  merged_at: number | null;
  merged_by: string | null;
  author: string;
  page_title: string;
  space_id: string;
};

export type CrReview = {
  id: string;
  cr_id: string;
  user_id: string;
  verdict: Verdict;
  note: string;
  at: number;
  reviewer: string;
};

const COLS = `cr.*, u.name AS author, p.title AS page_title, p.space_id AS space_id`;
const FROM = `FROM change_requests cr
   JOIN users u ON u.id = cr.author_id
   JOIN pages p ON p.id = cr.page_id`;

export function createChangeRequest(input: {
  pageId: string;
  authorId: string;
  title: string;
  description?: string;
  proposedTitle: string;
  proposedContent: string;
}): ChangeRequest | null {
  const page = getPage(input.pageId);
  if (!page) return null;
  const id = newId();
  const at = now();
  getDb()
    .prepare(
      `INSERT INTO change_requests
         (id, page_id, author_id, title, description, status, proposed_title,
          proposed_content, base_updated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.pageId,
      input.authorId,
      input.title.trim().slice(0, 200) || "Untitled proposal",
      (input.description ?? "").trim().slice(0, 4000),
      input.proposedTitle,
      input.proposedContent,
      page.updated_at,
      at,
      at
    );
  return getChangeRequest(id);
}

export function getChangeRequest(id: string): ChangeRequest | null {
  return (
    (getDb()
      .prepare(`SELECT ${COLS} ${FROM} WHERE cr.id = ?`)
      .get(id) as ChangeRequest | undefined) ?? null
  );
}

export function listChangeRequests(opts: {
  pageId?: string;
  spaceId?: string;
  status?: CrStatus;
  limit?: number;
}): ChangeRequest[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.pageId) {
    where.push("cr.page_id = ?");
    args.push(opts.pageId);
  }
  if (opts.spaceId) {
    where.push("p.space_id = ?");
    args.push(opts.spaceId);
  }
  if (opts.status) {
    where.push("cr.status = ?");
    args.push(opts.status);
  }
  args.push(Math.min(opts.limit ?? 100, 500));
  return getDb()
    .prepare(
      `SELECT ${COLS} ${FROM}${
        where.length ? ` WHERE ${where.join(" AND ")}` : ""
      } ORDER BY cr.updated_at DESC LIMIT ?`
    )
    .all(...args) as ChangeRequest[];
}

/** Open requests per page, for a badge on the page without loading them all. */
export function openCrCount(pageId: string): number {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) AS c FROM change_requests WHERE page_id = ? AND status = 'open'"
    )
    .get(pageId) as { c: number };
  return row.c;
}

export function listReviews(crId: string): CrReview[] {
  return getDb()
    .prepare(
      `SELECT r.*, u.name AS reviewer FROM cr_reviews r
       JOIN users u ON u.id = r.user_id
       WHERE r.cr_id = ? ORDER BY r.at`
    )
    .all(crId) as CrReview[];
}

/**
 * One standing verdict per reviewer: a second review replaces the first,
 * because "approved, then asked for changes" should read as asking for
 * changes rather than as both at once.
 */
export function reviewChangeRequest(
  crId: string,
  userId: string,
  verdict: Verdict,
  note: string
) {
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM cr_reviews WHERE cr_id = ? AND user_id = ?").run(
      crId,
      userId
    );
    db.prepare(
      "INSERT INTO cr_reviews (id, cr_id, user_id, verdict, note, at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(newId(), crId, userId, verdict, note.trim().slice(0, 4000), now());
    db.prepare("UPDATE change_requests SET updated_at = ? WHERE id = ?").run(
      now(),
      crId
    );
  })();
}

export type MergeCheck = {
  /** False when the page moved since the proposal was written. */
  current: boolean;
  approvals: number;
  changesRequested: number;
  /** Reasons merging is blocked; empty means it may proceed. */
  blockers: string[];
};

export function mergeCheck(cr: ChangeRequest): MergeCheck {
  const page = getPage(cr.page_id);
  const reviews = listReviews(cr.id);
  const approvals = reviews.filter((r) => r.verdict === "approve").length;
  const changesRequested = reviews.filter((r) => r.verdict === "changes").length;
  const current = Boolean(page) && page!.updated_at === cr.base_updated_at;

  const blockers: string[] = [];
  if (cr.status !== "open") blockers.push(`This request is already ${cr.status}.`);
  if (!page) blockers.push("The page this proposes changes to no longer exists.");
  if (page && !current)
    blockers.push(
      "The page has changed since this was written — merging now would discard that edit."
    );
  if (changesRequested > 0)
    blockers.push("A reviewer has asked for changes.");
  return { current, approvals, changesRequested, blockers };
}

/**
 * Apply the proposal to the page. Returns null when a blocker stands, so a
 * caller cannot merge past a stale base or an outstanding objection by
 * accident.
 */
export function mergeChangeRequest(
  crId: string,
  mergerId: string
): ChangeRequest | null {
  const cr = getChangeRequest(crId);
  if (!cr) return null;
  if (mergeCheck(cr).blockers.length > 0) return null;

  const db = getDb();
  db.transaction(() => {
    savePage(cr.page_id, {
      title: cr.proposed_title,
      content: cr.proposed_content,
    });
    db.prepare(
      "UPDATE change_requests SET status = 'merged', merged_at = ?, merged_by = ?, updated_at = ? WHERE id = ?"
    ).run(now(), mergerId, now(), crId);
  })();
  return getChangeRequest(crId);
}

export function setChangeRequestStatus(id: string, status: CrStatus) {
  getDb()
    .prepare("UPDATE change_requests SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, now(), id);
}

/** Refresh a proposal's base to the page as it stands, keeping the proposed text. */
export function rebaseChangeRequest(id: string) {
  const cr = getChangeRequest(id);
  if (!cr) return;
  const page = getPage(cr.page_id);
  if (!page) return;
  getDb()
    .prepare(
      "UPDATE change_requests SET base_updated_at = ?, updated_at = ? WHERE id = ?"
    )
    .run(page.updated_at, now(), id);
}
