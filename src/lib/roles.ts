import "server-only";
import { cookies } from "next/headers";
import { getDb } from "./db";
import { spaceForVisitorToken, VISITOR_COOKIE } from "./visitors";
import { now } from "./util";
import type { User } from "./auth";
import { groupRoleFor, groupSpaceIds } from "./groups";
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
  // A direct membership and a group grant are unioned, stronger winning.
  // A group must never take access away: someone added to a reader group
  // while holding an editor seat stays an editor.
  const role = strongest(spaceRole(user.id, spaceId), groupRoleFor(user.id, spaceId));
  // Being signed in is not membership. Without this, the instance-wide
  // read/comment/propose that a signed-in non-member gets would apply to
  // private spaces too, and one account would open the whole library.
  if (!role && instanceRoleOf(user) !== "admin" && isPrivateSpace(spaceId)) {
    return [];
  }
  return capabilities(instanceRoleOf(user), role);
}

const ROLE_STRENGTH: SpaceRole[] = ["agent", "reader", "editor", "admin"];

function strongest(a: SpaceRole | null, b: SpaceRole | null): SpaceRole | null {
  if (!a) return b;
  if (!b) return a;
  // An agent grant is a ceiling, not a rung — it never loses to a stronger
  // one, because that is the whole point of it.
  if (a === "agent" || b === "agent") return "agent";
  return ROLE_STRENGTH.indexOf(a) >= ROLE_STRENGTH.indexOf(b) ? a : b;
}

/** Cheap enough to call per check; SQLite reads this from the page cache. */
function isPrivateSpace(spaceId: string): boolean {
  const row = getDb()
    .prepare("SELECT visibility FROM spaces WHERE id = ?")
    .get(spaceId) as { visibility: string } | undefined;
  return row?.visibility === "private";
}

export function may(
  user: User | null,
  spaceId: string,
  capability: Capability
): boolean {
  return capsFor(user, spaceId).includes(capability);
}

/**
 * An AI principal, wherever it appears. The ceiling in ./capabilities holds
 * for anything expressed as a capability on a space; this covers the routes
 * that have no space to check against yet — creating one, uploading into the
 * library, running a connector outward.
 */
export function isAgent(user: User | null): boolean {
  return String(user?.role) === "agent";
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

/**
 * Which spaces this principal may read.
 *
 * "private" has to mean private *from other members*, not merely from people
 * who are signed out. Treating any authenticated session as sufficient makes
 * the blast radius of one account — a contractor, a leaver, a reused password
 * — the entire library, which is exactly what a private space exists to
 * prevent.
 *
 * Returns "all" for an instance admin, otherwise the ids of private spaces
 * this person belongs to. Public spaces are always readable and are not
 * listed here.
 */
export function readablePrivateSpaceIds(user: User | null): "all" | string[] {
  if (!user) return [];
  if (user.role === "admin") return "all";
  const direct = (
    getDb()
      .prepare("SELECT space_id FROM space_members WHERE user_id = ?")
      .all(user.id) as { space_id: string }[]
  ).map((r) => r.space_id);
  return [...new Set([...direct, ...groupSpaceIds(user.id)])];
}

/** May this principal read this space at all? */
/**
 * canReadSpace, plus the visitor door.
 *
 * A visitor token grants exactly one thing: reading this one space while the
 * token lives. It is checked only after the membership check fails, adds no
 * capability, and is re-validated against the stored hash on every request —
 * revoking a token ends access on the next click, cookie or no cookie.
 */
export async function canReadSpaceAsVisitor(
  user: User | null,
  space: { id: string; visibility?: string }
): Promise<boolean> {
  if (canReadSpace(user, space)) return true;
  const jar = await cookies();
  const token = jar.get(VISITOR_COOKIE)?.value;
  if (!token) return false;
  return spaceForVisitorToken(token) === space.id;
}

export function canReadSpace(
  user: User | null,
  space: { id: string; visibility?: string }
): boolean {
  if ((space.visibility ?? "public") !== "private") return true;
  const scope = readablePrivateSpaceIds(user);
  return scope === "all" || scope.includes(space.id);
}
