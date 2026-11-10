import { createHash } from "node:crypto";

export type ReviewRecord = {
  ownerId: string | null;
  dueAt: number | null;
  verifiedAt: number | null;
  verifiedBy: string | null;
  verifiedRevision: string | null;
};

export type ReviewState = "unreviewed" | "stale" | "changed" | "overdue" | "verified";
export type ReviewPage = { title: string; content: string; updatedAt: number };

function timestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid review timestamp");
}

/** Exact stored title/content, so even an edit within the same millisecond invalidates verification. */
export function reviewRevision(page: Pick<ReviewPage, "title" | "content">): string {
  return createHash("sha256").update(JSON.stringify([page.title, page.content])).digest("hex");
}

export function reviewState(page: ReviewPage, record: ReviewRecord | null, now: number): ReviewState {
  timestamp(now);
  timestamp(page.updatedAt);
  if (record?.dueAt !== null && record?.dueAt !== undefined) timestamp(record.dueAt);
  if (record?.verifiedAt !== null && record?.verifiedAt !== undefined) timestamp(record.verifiedAt);
  const verified = record?.verifiedAt !== null && record?.verifiedAt !== undefined
    && record.verifiedAt <= now && Boolean(record.verifiedBy) && Boolean(record.verifiedRevision);
  if (verified && record!.verifiedRevision !== reviewRevision(page)) return "changed";
  if (record?.dueAt !== null && record?.dueAt !== undefined && record.dueAt <= now) return "overdue";
  if (verified) return "verified";
  return page.updatedAt <= now - 180 * 86400_000 ? "stale" : "unreviewed";
}

/**
 * Pure transition; the persistence layer must authorize the reviewer and check
 * the expected revision inside the same transaction that writes this record.
 * This returns review metadata only and never rewrites page content or updatedAt.
 */
export function completeReview(input: {
  page: ReviewPage;
  previous: ReviewRecord | null;
  expectedRevision: string;
  reviewerId: string;
  now: number;
  nextDueAt: number;
}): ReviewRecord {
  timestamp(input.now);
  timestamp(input.nextDueAt);
  if (!input.reviewerId.trim()) throw new Error("Reviewer is required");
  if (input.nextDueAt <= input.now) throw new Error("Next review must be in the future");
  const revision = reviewRevision(input.page);
  if (revision !== input.expectedRevision) throw new Error("Page changed; review the latest revision");
  return {
    ownerId: input.previous?.ownerId ?? null,
    dueAt: input.nextDueAt,
    verifiedAt: input.now,
    verifiedBy: input.reviewerId,
    verifiedRevision: revision,
  };
}
