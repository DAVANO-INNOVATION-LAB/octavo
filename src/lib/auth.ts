import "server-only";
import { cookies } from "next/headers";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getDb } from "./db";
import { newId, now } from "./util";

const SESSION_COOKIE = "octavo_session";
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30; // 30 days

export type User = {
  id: string;
  email: string;
  name: string;
  role: string;
};

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
}

export function userCount(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM users").get() as {
    n: number;
  };
  return row.n;
}

export function createUser(email: string, name: string, password: string) {
  const id = newId();
  getDb()
    .prepare(
      "INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'admin', ?)"
    )
    .run(id, email.toLowerCase().trim(), name.trim(), hashPassword(password), now());
  return id;
}

export async function createSession(userId: string) {
  const id = randomBytes(32).toString("hex");
  getDb()
    .prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
    .run(id, userId, now() + SESSION_TTL);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL / 1000,
  });
}

export async function destroySession() {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (id) getDb().prepare("DELETE FROM sessions WHERE id = ?").run(id);
  jar.delete(SESSION_COOKIE);
}

export async function currentUser(): Promise<User | null> {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (!id) return null;
  const row = getDb()
    .prepare(
      `SELECT u.id, u.email, u.name, u.role, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`
    )
    .get(id) as (User & { expires_at: number }) | undefined;
  if (!row) return null;
  if (row.expires_at < now()) {
    getDb().prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return null;
  }
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export function authenticate(email: string, password: string): User | null {
  const row = getDb()
    .prepare("SELECT id, email, name, role, password_hash FROM users WHERE email = ?")
    .get(email.toLowerCase().trim()) as
    | (User & { password_hash: string })
    | undefined;
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

/**
 * Find or create the local account for an OIDC identity.
 * Matching order: (issuer, sub) → email (links an existing local account) →
 * create. First user ever becomes admin; later SSO arrivals are members.
 */
export function upsertOidcUser(input: {
  issuer: string;
  sub: string;
  email: string;
  name: string;
  /** Role for a brand-new SSO account (first user is always admin). */
  role?: "member" | "admin";
}): User {
  const db = getDb();
  const email = input.email.toLowerCase().trim();

  const bySub = db
    .prepare(
      "SELECT id, email, name, role FROM users WHERE oidc_issuer = ? AND oidc_sub = ?"
    )
    .get(input.issuer, input.sub) as User | undefined;
  if (bySub) return bySub;

  const byEmail = db
    .prepare("SELECT id, email, name, role FROM users WHERE email = ?")
    .get(email) as User | undefined;
  if (byEmail) {
    db.prepare("UPDATE users SET oidc_issuer = ?, oidc_sub = ? WHERE id = ?").run(
      input.issuer,
      input.sub,
      byEmail.id
    );
    return byEmail;
  }

  const id = newId();
  const role = userCount() === 0 ? "admin" : (input.role ?? "member");
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, role, created_at, oidc_issuer, oidc_sub)
     VALUES (?, ?, ?, 'oidc', ?, ?, ?, ?)`
  ).run(id, email, input.name.trim() || email, role, now(), input.issuer, input.sub);
  return { id, email, name: input.name.trim() || email, role };
}

/** Persistent per-instance secret for signing short-lived tokens. */
function instanceSecret(): string {
  const db = getDb();
  const row = db.prepare("SELECT value FROM kv WHERE key = 'instance_secret'").get() as
    | { value: string }
    | undefined;
  if (row) return row.value;
  const secret = randomBytes(32).toString("hex");
  db.prepare("INSERT OR IGNORE INTO kv (key, value) VALUES ('instance_secret', ?)").run(secret);
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", instanceSecret()).update(payload).digest("hex");
}

/** Short-lived token proving the password step passed, pending TOTP. */
export function issuePendingToken(userId: string): string {
  const exp = now() + 5 * 60 * 1000;
  const payload = `${userId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function consumePendingToken(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, expStr, mac] = parts;
  const payload = `${userId}.${expStr}`;
  const expected = sign(payload);
  if (mac.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  if (Number(expStr) < now()) return null;
  return userId;
}

export function getTotpSecret(userId: string): string | null {
  const row = getDb()
    .prepare("SELECT totp_secret FROM users WHERE id = ?")
    .get(userId) as { totp_secret: string | null } | undefined;
  return row?.totp_secret ?? null;
}

export function setTotpSecret(userId: string, secret: string | null) {
  getDb().prepare("UPDATE users SET totp_secret = ? WHERE id = ?").run(secret, userId);
}

export type AdminUserRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  created_at: number;
  has_totp: number;
  sso: number;
};

export function listUsers(): AdminUserRow[] {
  return getDb()
    .prepare(
      `SELECT id, email, name, role, created_at,
              (totp_secret IS NOT NULL) AS has_totp,
              (oidc_issuer IS NOT NULL) AS sso
       FROM users ORDER BY created_at`
    )
    .all() as AdminUserRow[];
}

export function setUserRole(id: string, role: "admin" | "member") {
  getDb().prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
}

export function deleteUser(id: string) {
  getDb().prepare("DELETE FROM users WHERE id = ?").run(id);
}

export function findUserByEmail(email: string): User | null {
  return (getDb()
    .prepare("SELECT id, email, name, role FROM users WHERE email = ?")
    .get(email.toLowerCase().trim()) ?? null) as User | null;
}
