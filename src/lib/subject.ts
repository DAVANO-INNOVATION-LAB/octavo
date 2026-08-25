import "server-only";
import { getDb } from "./db";
import { now } from "./util";

/**
 * Everything the instance holds about one person: exported on request,
 * removed on request.
 *
 * One tension is named rather than papered over. The audit log is a hash
 * chain — rewriting an actor's name in old entries would break every hash
 * after them and destroy the log's integrity for everyone else. So erasure
 * removes the account, its sessions, its memberships and its comments, and
 * scrubs the *account row*, but the audit entries keep the name they were
 * written with. The export includes those entries in full, so the person can
 * see exactly what remains and why. An operator whose rules require more can
 * export the log, prune it wholesale via the retention policy, and let the
 * chain restart — losing history for everyone is the honest cost of that
 * choice, and it is theirs to make, not ours to hide.
 */

export type SubjectExport = {
  exported_at: number;
  account: Record<string, unknown> | null;
  memberships: unknown[];
  groups: unknown[];
  comments: unknown[];
  change_requests: unknown[];
  notifications: unknown[];
  audit_entries: unknown[];
  note: string;
};

export function exportSubject(userId: string): SubjectExport {
  const db = getDb();
  const account = db
    .prepare(
      "SELECT id, email, name, role, created_at, oidc_issuer FROM users WHERE id = ?"
    )
    .get(userId) as Record<string, unknown> | undefined;

  return {
    exported_at: now(),
    account: account ?? null,
    memberships: db
      .prepare(
        `SELECT s.name AS space, m.role, m.added_at
           FROM space_members m JOIN spaces s ON s.id = m.space_id
          WHERE m.user_id = ?`
      )
      .all(userId),
    groups: db
      .prepare(
        `SELECT g.name, m.from_claim, m.added_at
           FROM group_members m JOIN groups g ON g.id = m.group_id
          WHERE m.user_id = ?`
      )
      .all(userId),
    comments: db
      .prepare(
        "SELECT id, page_id, body, created_at, resolved FROM comments WHERE user_id = ?"
      )
      .all(userId),
    change_requests: db
      .prepare(
        "SELECT id, page_id, title, description, status, created_at FROM change_requests WHERE author_id = ?"
      )
      .all(userId),
    notifications: db
      .prepare(
        "SELECT id, kind, title, created_at, read_at FROM notifications WHERE user_id = ?"
      )
      .all(userId),
    audit_entries: db
      .prepare("SELECT * FROM audit_log WHERE actor_id = ? ORDER BY at")
      .all(userId),
    note:
      "Audit entries are part of a hash-chained integrity record. Deleting the " +
      "account removes it, its sessions, memberships, comments and " +
      "notifications; audit entries retain the recorded actor name because " +
      "rewriting them would break the chain for every later entry. The " +
      "instance's audit retention policy governs how long they are kept.",
  };
}

/**
 * Remove the person. Content they wrote into shared pages stays — a page is
 * the library's, and its history must keep making sense — but everything
 * that is *theirs* goes, and their comments go with them.
 */
export function eraseSubject(userId: string): {
  comments: number;
  notifications: number;
} {
  const db = getDb();
  let comments = 0;
  let notifications = 0;
  db.transaction(() => {
    comments = db.prepare("DELETE FROM comments WHERE user_id = ?").run(userId).changes;
    notifications = db
      .prepare("DELETE FROM notifications WHERE user_id = ?")
      .run(userId).changes;
    // sessions, space_members, group_members cascade from the user row
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  })();
  return { comments, notifications };
}
