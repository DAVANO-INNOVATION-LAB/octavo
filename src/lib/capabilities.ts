/**
 * Who may do what.
 *
 * Four roles, each one a real answer to a question people actually ask:
 *
 *   admin     runs the space — settings, members, connectors, sync
 *   editor    writes: creates, edits, publishes, and merges proposals
 *   reader    reads, discusses, and proposes; changes nothing directly
 *   agent     reads and proposes; no comments or direct changes
 *
 * An instance-agent role or direct space-agent membership is a hard ceiling:
 * it cannot be strengthened by another grant. Agents propose; people merge.
 * An agent group is instead a read/propose grant, unioned with stronger human
 * grants in ./roles before this matrix is called. Adding an agent group must
 * not reduce existing human grants or instance-admin rights.
 *
 * This module is pure so the matrix can be tested directly rather than
 * inferred from the behaviour of the pages that consult it.
 */

export type SpaceRole = "admin" | "editor" | "reader" | "agent";

/** Instance-level role. "agent" here caps the principal everywhere. */
export type InstanceRole = "admin" | "member" | "agent";

export type Capability =
  | "read"
  | "comment"
  | "propose"
  | "write"
  | "publish"
  | "merge"
  | "administer";

const MATRIX: Record<SpaceRole, Capability[]> = {
  admin: ["read", "comment", "propose", "write", "publish", "merge", "administer"],
  editor: ["read", "comment", "propose", "write", "publish", "merge"],
  reader: ["read", "comment", "propose"],
  agent: ["read", "propose"],
};

/** What an instance/direct agent may do regardless of other grants. */
const AGENT_CEILING: Capability[] = ["read", "propose"];

export const SPACE_ROLES: SpaceRole[] = ["admin", "editor", "reader", "agent"];

export const ROLE_LABEL: Record<SpaceRole, string> = {
  admin: "Admin",
  editor: "Editor",
  reader: "Reader",
  agent: "AI Agent",
};

export const ROLE_BLURB: Record<SpaceRole, string> = {
  admin: "Runs the space: settings, members, connectors, and sync.",
  editor: "Writes, publishes, and merges proposed changes.",
  reader: "Reads and discusses, and can propose changes for review.",
  agent: "An AI principal. Reads and proposes; never writes or merges.",
};

/**
 * Resolve a principal's capabilities in one space.
 *
 * `instanceRole` of "admin" administers every space — that is what running
 * the library means. An instance role of "agent" overrides in the other
 * direction and is not escapable.
 */
export function capabilities(
  instanceRole: InstanceRole | null,
  spaceRole: SpaceRole | null
): Capability[] {
  // The ceiling is checked first and against both roles. An agent that is
  // also an instance admin is still an agent; otherwise the ceiling would be
  // one careless membership away from meaningless.
  if (instanceRole === "agent" || spaceRole === "agent") return [...AGENT_CEILING];
  if (instanceRole === "admin") return [...MATRIX.admin];
  if (spaceRole) return [...(MATRIX[spaceRole] ?? MATRIX.reader)];
  // Signed in with no membership: a member of the library may read and take
  // part, but changing a space they were not added to is not theirs to do.
  return instanceRole ? ["read", "comment", "propose"] : [];
}

export function can(
  instanceRole: InstanceRole | null,
  spaceRole: SpaceRole | null,
  capability: Capability
): boolean {
  return capabilities(instanceRole, spaceRole).includes(capability);
}

/** Normalize anything stored or submitted into a role we recognise. */
export function asSpaceRole(value: unknown): SpaceRole {
  const v = String(value ?? "").toLowerCase();
  return (SPACE_ROLES as string[]).includes(v) ? (v as SpaceRole) : "reader";
}
