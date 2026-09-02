import "server-only";
import { createHash } from "node:crypto";
import { getDb } from "./db";
import { newId, now } from "./util";
import { forwardAudit } from "./audit-forward";

/**
 * The audit log: who did what, when, and whether the record still adds up.
 *
 * Rows are append-only and chained — each carries the hash of the one before
 * it, so removing or editing any entry breaks every hash after it and
 * `verifyChain` reports where.
 *
 * What the chain does NOT do is stop someone with write access to the
 * database file from rewriting it from the tampered point forward. Nothing
 * that keeps its own log on its own disk can. The head hash is exposed so an
 * operator can anchor it somewhere the instance does not control; a chain
 * plus an external anchor is genuinely tamper-evident, a chain alone is only
 * evident against someone who cannot reach the file.
 */

export type AuditAction =
  // authentication
  | "auth.signin"
  | "auth.signin_failed"
  | "auth.signout"
  | "auth.totp_enabled"
  | "auth.totp_disabled"
  | "auth.totp_reset"
  | "auth.oidc_linked"
  // accounts
  | "user.created"
  | "user.role_changed"
  | "user.deleted"
  // spaces
  | "space.created"
  | "space.deleted"
  | "space.updated"
  | "space.visibility_changed"
  // membership
  | "member.added"
  | "member.role_changed"
  | "member.removed"
  // content
  | "page.published"
  | "page.unpublished"
  | "page.deleted"
  | "page.version_restored"
  // connectors
  | "connector.created"
  | "connector.deleted"
  | "connector.dispatched"
  // administration
  | "admin.oidc_saved"
  | "admin.settings_changed"
  | "admin.backup_created"
  | "admin.snapshot_restored"
  // change requests
  | "cr.created"
  | "cr.merged"
  | "cr.closed"
  | "cr.reopened"
  // sync
  | "sync.run"
  | "repo.connected"
  | "repo.disconnected"
  | "repo.sync"
  | "site.created"
  | "site.updated"
  | "site.deleted"
  // moderation
  | "comment.deleted_by_moderator"
  | "comment.thread_resolved"
  // groups
  | "group.created"
  | "group.deleted"
  // visitors
  | "visit.opened"
  | "visit.token_created"
  | "visit.token_revoked"
  // egress
  | "export.space"
  | "export.audit_log"
  | "export.subject"
  // the log about the log
  | "audit.pruned";

export type AuditEntry = {
  id: string;
  at: number;
  actor_id: string | null;
  actor_name: string;
  action: AuditAction;
  object_type: string;
  object_id: string;
  object_label: string;
  space_id: string | null;
  detail: string;
  prev_hash: string;
  hash: string;
};

/** The first link. Any chain that does not start here has lost its head. */
const GENESIS = "0".repeat(64);

/**
 * Exactly the bytes that are hashed. Field order is fixed and the separator
 * cannot occur in a field value that has not been JSON-encoded, so two
 * different rows can never produce the same digest input.
 */
function canonical(e: Omit<AuditEntry, "hash">): string {
  return [
    e.id,
    String(e.at),
    e.actor_id ?? "",
    e.actor_name,
    e.action,
    e.object_type,
    e.object_id,
    e.object_label,
    e.space_id ?? "",
    e.detail,
    e.prev_hash,
  ]
    .map((v) => JSON.stringify(v))
    .join("");
}

function digest(e: Omit<AuditEntry, "hash">): string {
  return createHash("sha256").update(canonical(e)).digest("hex");
}

/** The most recent hash, or the genesis value on an empty log. */
export function headHash(): string {
  const row = getDb()
    .prepare("SELECT hash FROM audit_log ORDER BY at DESC, rowid DESC LIMIT 1")
    .get() as { hash: string } | undefined;
  return row?.hash ?? GENESIS;
}

/**
 * Append one event. Never throws into the caller: an audit write failing
 * must not take down the action being audited, but it must be loud in the
 * logs, because a silently missing audit trail is worse than an obvious one.
 */
export function recordAudit(input: {
  actor: { id: string; name: string } | null;
  action: AuditAction;
  objectType: string;
  objectId?: string;
  objectLabel?: string;
  spaceId?: string | null;
  detail?: Record<string, unknown>;
}): void {
  let committed: AuditEntry | null = null;
  try {
    const db = getDb();
    // Reading the head and inserting must not interleave with another writer.
    // SQLite gives one writer, and this transaction makes the pair atomic.
    db.transaction(() => {
      const prev = headHash();
      const partial = {
        id: newId(),
        at: now(),
        actor_id: input.actor?.id ?? null,
        actor_name: input.actor?.name ?? "anonymous",
        action: input.action,
        object_type: input.objectType,
        object_id: input.objectId ?? "",
        object_label: input.objectLabel ?? "",
        space_id: input.spaceId ?? null,
        detail: input.detail ? JSON.stringify(input.detail) : "",
        prev_hash: prev,
      };
      const row = { ...partial, hash: digest(partial) };
      db.prepare(
        `INSERT INTO audit_log
           (id, at, actor_id, actor_name, action, object_type, object_id,
            object_label, space_id, detail, prev_hash, hash)
         VALUES (@id, @at, @actor_id, @actor_name, @action, @object_type,
                 @object_id, @object_label, @space_id, @detail, @prev_hash, @hash)`
      ).run(row);
      committed = row as AuditEntry;
    })();

    // Only after the entry is durable and chained. Forwarding a record that
    // then failed to commit would put an event in the collector that this
    // instance cannot show you.
    if (committed) forwardAudit(committed);
  } catch (err) {
    console.error("audit: failed to record", input.action, err);
  }
}

export type AuditQuery = {
  actorId?: string;
  action?: string;
  spaceId?: string;
  /** Restrict to these spaces — how a space admin is held to their own scope. */
  spaceScope?: string[];
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
};

export function listAudit(q: AuditQuery = {}): AuditEntry[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.actorId) {
    where.push("actor_id = ?");
    args.push(q.actorId);
  }
  if (q.action) {
    where.push("action = ?");
    args.push(q.action);
  }
  if (q.spaceId) {
    where.push("space_id = ?");
    args.push(q.spaceId);
  }
  if (q.spaceScope) {
    if (q.spaceScope.length === 0) return [];
    where.push(`space_id IN (${q.spaceScope.map(() => "?").join(",")})`);
    args.push(...q.spaceScope);
  }
  if (q.from) {
    where.push("at >= ?");
    args.push(q.from);
  }
  if (q.to) {
    where.push("at <= ?");
    args.push(q.to);
  }
  const sql = `SELECT * FROM audit_log${
    where.length ? ` WHERE ${where.join(" AND ")}` : ""
  } ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?`;
  args.push(Math.min(q.limit ?? 100, 1000), q.offset ?? 0);
  return getDb().prepare(sql).all(...args) as AuditEntry[];
}

export function countAudit(q: AuditQuery = {}): number {
  const rows = listAudit({ ...q, limit: 1000, offset: 0 });
  return rows.length;
}

/** Distinct actions present, so the filter offers only what exists. */
export function auditActions(): string[] {
  return (
    getDb()
      .prepare("SELECT DISTINCT action FROM audit_log ORDER BY action")
      .all() as { action: string }[]
  ).map((r) => r.action);
}

export type ChainResult =
  | { ok: true; entries: number; head: string }
  | { ok: false; entries: number; head: string; brokenAt: string; why: string };

/**
 * Walk the chain oldest to newest and report the first entry that does not
 * add up — either because its own contents no longer match its hash, or
 * because it does not follow the entry before it.
 */
export function verifyChain(): ChainResult {
  const rows = getDb()
    .prepare("SELECT * FROM audit_log ORDER BY at ASC, rowid ASC")
    .all() as AuditEntry[];

  let prev = GENESIS;
  for (const row of rows) {
    if (row.prev_hash !== prev) {
      return {
        ok: false,
        entries: rows.length,
        head: headHash(),
        brokenAt: row.id,
        why: "an entry is missing or out of order before this one",
      };
    }
    const { hash, ...rest } = row;
    if (digest(rest) !== hash) {
      return {
        ok: false,
        entries: rows.length,
        head: headHash(),
        brokenAt: row.id,
        why: "this entry's contents do not match its hash",
      };
    }
    prev = hash;
  }
  return { ok: true, entries: rows.length, head: prev };
}
