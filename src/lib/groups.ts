import "server-only";
import { getDb } from "./db";
import { newId, now } from "./util";
import { asSpaceRole, type SpaceRole } from "./capabilities";

/**
 * Groups: grant a role to a set of people at once.
 *
 * A space membership is still the authority on what someone may do. A group
 * is a second way for that grant to arrive, and the two are unioned with the
 * stronger winning — being in an editor group and a reader group makes you an
 * editor, because the alternative is that adding someone to a group can take
 * access away, which nobody expects.
 *
 * When an identity provider owns a group, its membership is *replaced* on
 * each sign-in rather than merged. Someone removed from a group upstream has
 * to lose the access here, and merging would silently keep it forever.
 */

export type Group = {
  id: string;
  name: string;
  claim_value: string;
  created_at: number;
};

export type GroupGrant = { space_id: string; role: SpaceRole };

export function listGroups(): Group[] {
  return getDb()
    .prepare("SELECT * FROM groups ORDER BY name")
    .all() as Group[];
}

export function getGroup(id: string): Group | null {
  return (getDb().prepare("SELECT * FROM groups WHERE id = ?").get(id) ??
    null) as Group | null;
}

export function createGroup(name: string, claimValue = ""): Group | null {
  const clean = name.trim().slice(0, 80);
  if (!clean) return null;
  const g: Group = {
    id: newId(),
    name: clean,
    claim_value: claimValue.trim().slice(0, 200),
    created_at: now(),
  };
  try {
    getDb()
      .prepare(
        "INSERT INTO groups (id, name, claim_value, created_at) VALUES (@id, @name, @claim_value, @created_at)"
      )
      .run(g);
  } catch {
    return null; // name already taken
  }
  return g;
}

export function deleteGroup(id: string): void {
  getDb().prepare("DELETE FROM groups WHERE id = ?").run(id);
}

export function setGroupClaim(id: string, claimValue: string): void {
  getDb()
    .prepare("UPDATE groups SET claim_value = ? WHERE id = ?")
    .run(claimValue.trim().slice(0, 200), id);
}

export function groupMembers(
  groupId: string
): { user_id: string; name: string; email: string; from_claim: number }[] {
  return getDb()
    .prepare(
      `SELECT m.user_id, u.name, u.email, m.from_claim
         FROM group_members m JOIN users u ON u.id = m.user_id
        WHERE m.group_id = ? ORDER BY u.name`
    )
    .all(groupId) as {
    user_id: string;
    name: string;
    email: string;
    from_claim: number;
  }[];
}

export function addGroupMember(groupId: string, userId: string): void {
  getDb()
    .prepare(
      `INSERT INTO group_members (group_id, user_id, from_claim, added_at)
       VALUES (?, ?, 0, ?)
       ON CONFLICT(group_id, user_id) DO UPDATE SET from_claim = 0`
    )
    .run(groupId, userId, now());
}

export function removeGroupMember(groupId: string, userId: string): void {
  getDb()
    .prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?")
    .run(groupId, userId);
}

export function groupGrants(groupId: string): GroupGrant[] {
  return getDb()
    .prepare("SELECT space_id, role FROM group_space_roles WHERE group_id = ?")
    .all(groupId) as GroupGrant[];
}

export function setGroupGrant(
  groupId: string,
  spaceId: string,
  role: string | null
): void {
  const db = getDb();
  if (role === null) {
    db.prepare(
      "DELETE FROM group_space_roles WHERE group_id = ? AND space_id = ?"
    ).run(groupId, spaceId);
    return;
  }
  db.prepare(
    `INSERT INTO group_space_roles (group_id, space_id, role) VALUES (?, ?, ?)
     ON CONFLICT(group_id, space_id) DO UPDATE SET role = excluded.role`
  ).run(groupId, spaceId, asSpaceRole(role));
}

/** Strongest first, so a union can be resolved by index. */
const STRENGTH: SpaceRole[] = ["agent", "reader", "editor", "admin"];

/**
 * The role a person's groups give them in one space, or null.
 *
 * Agent is deliberately at the weak end: an agent grant must never be
 * strengthened by another membership, and the ceiling in ./capabilities
 * enforces that separately for the instance role. Here it simply loses.
 */
export function groupRoleFor(userId: string, spaceId: string): SpaceRole | null {
  const rows = getDb()
    .prepare(
      `SELECT r.role FROM group_space_roles r
         JOIN group_members m ON m.group_id = r.group_id
        WHERE m.user_id = ? AND r.space_id = ?`
    )
    .all(userId, spaceId) as { role: SpaceRole }[];
  let best: SpaceRole | null = null;
  for (const { role } of rows) {
    const r = asSpaceRole(role);
    if (r === "agent") continue;
    if (!best || STRENGTH.indexOf(r) > STRENGTH.indexOf(best)) best = r;
  }
  return best;
}

/** Every space a person can reach through a group. */
export function groupSpaceIds(userId: string): string[] {
  return (
    getDb()
      .prepare(
        `SELECT DISTINCT r.space_id FROM group_space_roles r
           JOIN group_members m ON m.group_id = r.group_id
          WHERE m.user_id = ?`
      )
      .all(userId) as { space_id: string }[]
  ).map((r) => r.space_id);
}

/**
 * Reconcile the groups an identity provider claims for someone.
 *
 * Replaces every claim-derived membership in one transaction. Memberships
 * added by hand in Octavo are left alone — an operator's explicit grant is
 * not the IdP's to remove.
 */
export function syncClaimGroups(userId: string, claimed: string[]): number {
  const db = getDb();
  const wanted = new Set(
    claimed.map((c) => String(c ?? "").trim()).filter(Boolean)
  );
  let changed = 0;
  db.transaction(() => {
    const groups = db
      .prepare("SELECT id, claim_value FROM groups WHERE claim_value != ''")
      .all() as { id: string; claim_value: string }[];
    for (const g of groups) {
      const shouldBeIn = wanted.has(g.claim_value);
      const row = db
        .prepare(
          "SELECT from_claim FROM group_members WHERE group_id = ? AND user_id = ?"
        )
        .get(g.id, userId) as { from_claim: number } | undefined;
      if (shouldBeIn && !row) {
        db.prepare(
          "INSERT INTO group_members (group_id, user_id, from_claim, added_at) VALUES (?, ?, 1, ?)"
        ).run(g.id, userId, now());
        changed++;
      } else if (!shouldBeIn && row?.from_claim === 1) {
        db.prepare(
          "DELETE FROM group_members WHERE group_id = ? AND user_id = ?"
        ).run(g.id, userId);
        changed++;
      }
    }
  })();
  return changed;
}
