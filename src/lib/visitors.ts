import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb } from "./db";
import { newId, now } from "./util";

/**
 * Visitor tokens: a link that opens one private space to someone outside the
 * library, for a while, revocably.
 *
 * Private used to mean "signed out cannot see this", which left an accidental
 * sharing mechanism — any account could read any private space. Closing that
 * removed the only way to show a private space to an outside reviewer without
 * creating them an account. This is the deliberate replacement.
 *
 * Three properties it has to have, and each one is a decision:
 *
 *   read only        a visitor never writes, comments, or proposes. The link
 *                    is a window, not a seat.
 *   one space        a token names a space; it is never a key to the library.
 *   hashed at rest   only the digest is stored, so a copy of the database
 *                    yields no working links. An operator who loses the link
 *                    issues a new one rather than recovering the old.
 */

export const VISITOR_COOKIE = "octavo_visit";

export type VisitorToken = {
  id: string;
  space_id: string;
  token_hash: string;
  label: string;
  created_by: string | null;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
  uses: number;
};

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Issue a token. The plain value is returned exactly once — it is never
 * stored and cannot be shown again.
 */
export function createVisitorToken(input: {
  spaceId: string;
  label: string;
  days: number;
  createdBy: string | null;
}): { token: string; row: VisitorToken } {
  const token = randomBytes(32).toString("base64url");
  const days = Math.min(365, Math.max(1, Math.round(input.days) || 7));
  const row: VisitorToken = {
    id: newId(),
    space_id: input.spaceId,
    token_hash: hash(token),
    label: input.label.trim().slice(0, 120),
    created_by: input.createdBy,
    created_at: now(),
    expires_at: now() + days * 86_400_000,
    revoked_at: null,
    last_used_at: null,
    uses: 0,
  };
  getDb()
    .prepare(
      `INSERT INTO visitor_tokens
         (id, space_id, token_hash, label, created_by, created_at, expires_at, revoked_at, last_used_at, uses)
       VALUES (@id, @space_id, @token_hash, @label, @created_by, @created_at, @expires_at, @revoked_at, @last_used_at, @uses)`
    )
    .run(row);
  return { token, row };
}

export function listVisitorTokens(
  spaceId: string
): (VisitorToken & { dead: boolean })[] {
  const at = now();
  return (
    getDb()
      .prepare(
        "SELECT * FROM visitor_tokens WHERE space_id = ? ORDER BY created_at DESC"
      )
      .all(spaceId) as VisitorToken[]
  ).map((t) => ({ ...t, dead: t.revoked_at !== null || t.expires_at < at }));
}

export function revokeVisitorToken(id: string): void {
  getDb()
    .prepare("UPDATE visitor_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(now(), id);
}

/**
 * The space a token opens, or null.
 *
 * Compared in constant time. A lookup by hash would be a fine index but a
 * poor habit: the comparison a credential check does should not vary with how
 * much of it was right.
 */
export function spaceForVisitorToken(token: string | undefined): string | null {
  if (!token) return null;
  const digest = hash(token);
  const rows = getDb()
    .prepare(
      "SELECT id, space_id, token_hash, expires_at, revoked_at FROM visitor_tokens WHERE revoked_at IS NULL AND expires_at > ?"
    )
    .all(now()) as Pick<
    VisitorToken,
    "id" | "space_id" | "token_hash" | "expires_at" | "revoked_at"
  >[];

  const mine = Buffer.from(digest, "hex");
  for (const row of rows) {
    const theirs = Buffer.from(row.token_hash, "hex");
    if (theirs.length !== mine.length) continue;
    if (!timingSafeEqual(theirs, mine)) continue;
    getDb()
      .prepare("UPDATE visitor_tokens SET uses = uses + 1, last_used_at = ? WHERE id = ?")
      .run(now(), row.id);
    return row.space_id;
  }
  return null;
}

/** Housekeeping: tokens long past their expiry are of no further interest. */
export function pruneVisitorTokens(): number {
  return getDb()
    .prepare("DELETE FROM visitor_tokens WHERE expires_at < ?")
    .run(now() - 30 * 86_400_000).changes;
}
