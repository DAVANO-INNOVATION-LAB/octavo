import "server-only";
import { getDb } from "./db";
import { now } from "./util";
import type { User } from "./auth";
import {
  asSpaceRole,
  capabilities,
  type Capability,
  type InstanceRole,
  type SpaceRole,
} from "./capabilities";

// Authority has two layers:
//
//   instance role  — on the user record. "admin" runs the library: users,
//                    SSO, backups, and every space. "agent" caps a principal
//                    everywhere, whatever it is granted afterwards.
//   space role     — in space_members: admin, editor, reader, or agent.
//
// What each role may actually do lives in ./capabilities as a plain matrix,
// so it can be read and tested without inferring it from these queries.
//
// A space admin is the "tenant admin" of their space. When tenant namespaces
// land, a tenant is a group of spaces and this same table carries the
// membership — no third concept needed.

export type { SpaceRole } from "./capabilities";

export type SpaceMember = {
  user_id: string;
  name: string;
  email: string;
  role: SpaceRole;
  added_at: number;
};

/** The instance role as stored, narrowed to what the matrix understands. */
function instanceRoleOf(user: User | null): InstanceRole | null {
  if (!user) return null;
  const r = String(user.role);
  return r === "admin" || r === "agent" ? r : "member";
}

/** Everything a principal may do in one space. */
export function capsFor(user: User | null, spaceId: string): Capability[] {
  if (!user) return [];
  return capabilities(instanceRoleOf(user), spaceRole(user.id, spaceId));
}

export function may(
  user: User | null,
  spaceId: string,
  capability: Capability
): boolean {
  return capsFor(user, spaceId).includes(capability);
}

export function spaceRole(userId: string, spaceId: string): SpaceRole | null {
  const row = getDb()
    .prepare("SELECT role FROM space_members WHERE space_id = ? AND user_id = ?")
    .get(spaceId, userId) as { role: SpaceRole } | undefined;
  return row?.role ?? null;
}

/** Instance admins administer every space; space admins administer theirs. */
export function canAdminSpace(user: User | null, spaceId: string): boolean {
  return may(user, spaceId, "administer");
}

/** May change the pages themselves, rather than propose a change to them. */
export function canEditSpace(user: User | null, spaceId: string): boolean {
  return may(user, spaceId, "write");
}

export function listSpaceMembers(spaceId: string): SpaceMember[] {
  return getDb()
    .prepare(
      `SELECT m.user_id, u.name, u.email, m.role, m.added_at
       FROM space_members m JOIN users u ON u.id = m.user_id
       WHERE m.space_id = ? ORDER BY m.role, u.name`
    )
    .all(spaceId) as SpaceMember[];
}

export function setSpaceMember(
  spaceId: string,
  userId: string,
  role: SpaceRole
) {
  getDb()
    .prepare(
      `INSERT INTO space_members (space_id, user_id, role, added_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(space_id, user_id) DO UPDATE SET role = excluded.role`
    )
    .run(spaceId, userId, asSpaceRole(role), now());
}

export function removeSpaceMember(spaceId: string, userId: string) {
  getDb()
    .prepare("DELETE FROM space_members WHERE space_id = ? AND user_id = ?")
    .run(spaceId, userId);
}

/** Spaces this user administers (for the connector scope picker). */
export function spacesAdministeredBy(user: User): { id: string; name: string; slug: string }[] {
  const db = getDb();
  if (user.role === "admin")
    return db
      .prepare("SELECT id, name, slug FROM spaces ORDER BY position")
      .all() as { id: string; name: string; slug: string }[];
  return db
    .prepare(
      `SELECT s.id, s.name, s.slug FROM spaces s
       JOIN space_members m ON m.space_id = s.id
       WHERE m.user_id = ? AND m.role = 'admin' ORDER BY s.position`
    )
    .all(user.id) as { id: string; name: string; slug: string }[];
}

/**
 * Who should hear that a page needs review. Pages have no author, so the
 * people who can actually act on a proposal are the ones told about it:
 * the space's own admins, or the instance's admins when a space has none.
 */
export function reviewersFor(spaceId: string): string[] {
  // Whoever can actually merge: space admins and editors.
  const admins = listSpaceMembers(spaceId)
    .filter((m) => m.role === "admin" || m.role === "editor")
    .map((m) => m.user_id);
  if (admins.length > 0) return admins;
  return (
    getDb()
      .prepare("SELECT id FROM users WHERE role = 'admin'")
      .all() as { id: string }[]
  ).map((u) => u.id);
}
