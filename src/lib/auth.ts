import "server-only";
import { cookies } from "next/headers";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
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
  const role = userCount() === 0 ? "admin" : "member";
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, role, created_at, oidc_issuer, oidc_sub)
     VALUES (?, ?, ?, 'oidc', ?, ?, ?, ?)`
  ).run(id, email, input.name.trim() || email, role, now(), input.issuer, input.sub);
  return { id, email, name: input.name.trim() || email, role };
}
