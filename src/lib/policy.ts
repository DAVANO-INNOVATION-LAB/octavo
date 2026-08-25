import "server-only";
import { getDb } from "./db";
import { getSetting } from "./settings";
import { now } from "./util";
import { clampPolicy, DEFAULT_POLICY, type Policy } from "./policy-pure";

export { clampPolicy, DEFAULT_POLICY, type Policy };

/**
 * The knobs a security questionnaire asks about.
 *
 * Every one of these had an opinionated hard-coded value before, which is a
 * fine default and a bad answer when someone needs a different number for a
 * reason they are not obliged to explain. Defaults are unchanged; what is new
 * is that they can be changed.
 */

export function policy(): Policy {
  const raw = getSetting("policy");
  if (!raw) return { ...DEFAULT_POLICY };
  try {
    return clampPolicy(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export function sessionTtlMs(): number {
  return policy().sessionDays * 86_400_000;
}

/** Why a password was refused, in words a person can act on. */
export function passwordProblem(password: string): string | null {
  const min = policy().minPasswordLength;
  if (password.length < min)
    return `Passwords must be at least ${min} characters.`;
  return null;
}

export type Lockout = { locked: true; until: number } | { locked: false };

/**
 * Lockout is per email address, not per address of the caller.
 *
 * Counting by IP protects the account from one attacker and no others, and
 * punishes everyone behind a shared address. Counting by account is the thing
 * that actually bounds a guessing attack — at the cost that someone can lock
 * a colleague out, which is why the window is short and the audit log records
 * every failure.
 */
export function lockoutState(email: string): Lockout {
  const p = policy();
  const windowStart = now() - p.lockoutWindowMinutes * 60_000;
  const rows = getDb()
    .prepare(
      "SELECT at FROM signin_failures WHERE email = ? AND at >= ? ORDER BY at DESC"
    )
    .all(email.toLowerCase().trim(), windowStart) as { at: number }[];
  if (rows.length < p.lockoutThreshold) return { locked: false };
  const until = rows[0].at + p.lockoutMinutes * 60_000;
  return until > now() ? { locked: true, until } : { locked: false };
}

export function recordSigninFailure(email: string): void {
  const db = getDb();
  db.prepare("INSERT INTO signin_failures (email, at) VALUES (?, ?)").run(
    email.toLowerCase().trim(),
    now()
  );
  // Keep the table from growing without bound; nothing outside the window
  // affects any decision.
  const cutoff = now() - policy().lockoutWindowMinutes * 60_000 * 4;
  db.prepare("DELETE FROM signin_failures WHERE at < ?").run(cutoff);
}

export function clearSigninFailures(email: string): void {
  getDb()
    .prepare("DELETE FROM signin_failures WHERE email = ?")
    .run(email.toLowerCase().trim());
}

/** Prune the audit log if a retention period is set. Returns rows removed. */
export function pruneAudit(): number {
  const days = policy().auditRetentionDays;
  if (days <= 0) return 0;
  return getDb()
    .prepare("DELETE FROM audit_log WHERE at < ?")
    .run(now() - days * 86_400_000).changes;
}
