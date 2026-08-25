import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb } from "./db";
import { getSetting, setSetting } from "./settings";
import { newId, now } from "./util";

/**
 * SCIM 2.0, the subset identity providers actually call.
 *
 * Okta, Entra and the rest speak a lot less SCIM than the RFC describes:
 * they list users filtered by userName, create them, patch `active`, and
 * replace them. That subset is implemented completely rather than the whole
 * protocol partially — a provisioner that gets a correct answer to the four
 * calls it makes will run for years; one that gets 501s to calls we half-
 * implemented will page someone.
 *
 * Provisioned accounts have no password ("scim" is not a valid scrypt hash,
 * so it can never verify) — they sign in through SSO, which is the only
 * arrangement under which SCIM makes sense anyway.
 *
 * Deactivation keeps the row and kills the sessions. SCIM's `active: false`
 * means "this person left the company", and the provisioner may set it true
 * again when they return; deleting the account would turn a round-trip into
 * data loss.
 */

const TOKEN_KEY = "scim_token_hash";

export function scimEnabled(): boolean {
  return getSetting(TOKEN_KEY) !== null;
}

/** Issue (or rotate) the bearer token. The plain value is shown once. */
export function issueScimToken(): string {
  const token = "scim_" + randomBytes(32).toString("base64url");
  setSetting(TOKEN_KEY, createHash("sha256").update(token).digest("hex"));
  return token;
}

export function revokeScimToken(): void {
  setSetting(TOKEN_KEY, null);
}

export function scimAuthorized(header: string | null): boolean {
  const stored = getSetting(TOKEN_KEY);
  if (!stored || !header?.startsWith("Bearer ")) return false;
  const digest = createHash("sha256")
    .update(header.slice("Bearer ".length).trim())
    .digest("hex");
  const a = Buffer.from(digest, "hex");
  const b = Buffer.from(stored, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  created_at: number;
  active: number;
};

/** users.active: 1 unless a provisioner said otherwise. */
function ensureActiveColumn(): void {
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "active")) {
    db.exec("ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
  }
}

export function scimResource(u: UserRow) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: u.id,
    userName: u.email,
    name: { formatted: u.name },
    displayName: u.name,
    emails: [{ value: u.email, primary: true }],
    active: u.active !== 0,
    meta: {
      resourceType: "User",
      created: new Date(u.created_at).toISOString(),
    },
  };
}

export function scimList(filter: string | null, startIndex: number, count: number) {
  ensureActiveColumn();
  const db = getDb();
  // The one filter every provisioner sends: userName eq "someone@example.com"
  const m = filter?.match(/userName\s+eq\s+"([^"]+)"/i);
  const rows = (
    m
      ? db
          .prepare("SELECT id, email, name, role, created_at, active FROM users WHERE email = ?")
          .all(m[1].toLowerCase().trim())
      : db
          .prepare("SELECT id, email, name, role, created_at, active FROM users ORDER BY created_at")
          .all()
  ) as UserRow[];
  const page = rows.slice(startIndex - 1, startIndex - 1 + count);
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: rows.length,
    startIndex,
    itemsPerPage: page.length,
    Resources: page.map(scimResource),
  };
}

export function scimGet(id: string) {
  ensureActiveColumn();
  const row = getDb()
    .prepare("SELECT id, email, name, role, created_at, active FROM users WHERE id = ?")
    .get(id) as UserRow | undefined;
  return row ? scimResource(row) : null;
}

export function scimCreate(body: {
  userName?: string;
  displayName?: string;
  name?: { formatted?: string; givenName?: string; familyName?: string };
  emails?: { value?: string; primary?: boolean }[];
  active?: boolean;
}): ReturnType<typeof scimResource> | { conflict: true } {
  ensureActiveColumn();
  const db = getDb();
  const email = (
    body.emails?.find((e) => e.primary)?.value ??
    body.emails?.[0]?.value ??
    body.userName ??
    ""
  )
    .toLowerCase()
    .trim();
  const name =
    body.displayName?.trim() ||
    body.name?.formatted?.trim() ||
    [body.name?.givenName, body.name?.familyName].filter(Boolean).join(" ").trim() ||
    email;
  if (!email.includes("@")) return { conflict: true };

  const existing = db
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(email) as { id: string } | undefined;
  if (existing) return { conflict: true };

  const row: UserRow = {
    id: newId(),
    email,
    name,
    role: "member",
    created_at: now(),
    active: body.active === false ? 0 : 1,
  };
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, role, created_at, active)
     VALUES (@id, @email, @name, 'scim', @role, @created_at, @active)`
  ).run(row);
  return scimResource(row);
}

/** PATCH: only `active` moves; everything else the IdP owns arrives on PUT. */
export function scimPatch(
  id: string,
  ops: { op?: string; path?: string; value?: unknown }[]
): ReturnType<typeof scimGet> {
  ensureActiveColumn();
  const db = getDb();
  for (const op of ops) {
    if (String(op.op ?? "").toLowerCase() !== "replace") continue;
    const value = op.value as Record<string, unknown> | boolean | undefined;
    const active =
      op.path === "active"
        ? value
        : typeof value === "object" && value !== null
          ? (value as Record<string, unknown>).active
          : undefined;
    if (typeof active === "boolean" || active === "False" || active === "True") {
      const on = active === true || active === "True";
      db.prepare("UPDATE users SET active = ? WHERE id = ?").run(on ? 1 : 0, id);
      if (!on) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    }
  }
  return scimGet(id);
}

export function scimReplace(
  id: string,
  body: Parameters<typeof scimCreate>[0]
): ReturnType<typeof scimGet> {
  ensureActiveColumn();
  const db = getDb();
  const email = (
    body.emails?.find((e) => e.primary)?.value ??
    body.emails?.[0]?.value ??
    body.userName
  )
    ?.toLowerCase()
    .trim();
  const name = body.displayName?.trim() || body.name?.formatted?.trim();
  if (email?.includes("@"))
    db.prepare("UPDATE users SET email = ? WHERE id = ?").run(email, id);
  if (name) db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, id);
  if (body.active === false) {
    db.prepare("UPDATE users SET active = 0 WHERE id = ?").run(id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
  } else if (body.active === true) {
    db.prepare("UPDATE users SET active = 1 WHERE id = ?").run(id);
  }
  return scimGet(id);
}

/** Whether a deactivated account is trying to use the instance. */
export function isDeactivated(userId: string): boolean {
  ensureActiveColumn();
  const row = getDb()
    .prepare("SELECT active FROM users WHERE id = ?")
    .get(userId) as { active: number } | undefined;
  return row?.active === 0;
}
