import "server-only";
import { getDb } from "./db";
import { newId, now, slugify } from "./util";
import type { User } from "./auth";

/**
 * Tenant namespaces.
 *
 * A site changes how the library is presented. A tenant changes what the
 * library *is* for the people inside it: its spaces are invisible outside it,
 * including the public ones. "Public" means public within a tenant, and a
 * tenant whose public spaces leaked to the next tenant would be decorative.
 *
 * Membership comes from an OIDC group claim where a directory already knows
 * the answer, or by hand where it does not. Instance admins stand outside
 * tenancy entirely — somebody has to be able to run the instance.
 *
 * Spaces with no tenant belong to the library and are visible to everyone.
 * That is what every space is before anyone creates a tenant, and it has to
 * stay true or turning the feature on would hide the whole instance.
 */

export type Tenant = {
  id: string;
  slug: string;
  name: string;
  claim_value: string;
  accent: string;
  created_at: number;
};

export function listTenants(): Tenant[] {
  return getDb().prepare("SELECT * FROM tenants ORDER BY name").all() as Tenant[];
}

export function getTenant(id: string): Tenant | null {
  return (getDb().prepare("SELECT * FROM tenants WHERE id = ?").get(id) as Tenant) ?? null;
}

export function getTenantBySlug(slug: string): Tenant | null {
  return (getDb().prepare("SELECT * FROM tenants WHERE slug = ?").get(slug) as Tenant) ?? null;
}

export function createTenant(name: string): Tenant {
  const db = getDb();
  const id = newId();
  let slug = slugify(name) || "tenant";
  if (db.prepare("SELECT 1 FROM tenants WHERE slug = ?").get(slug))
    slug = `${slug}-${id.slice(0, 4)}`;
  db.prepare(
    "INSERT INTO tenants (id, slug, name, claim_value, accent, created_at) VALUES (?, ?, ?, '', '', ?)"
  ).run(id, slug, name.trim(), now());
  return getTenant(id)!;
}

export function updateTenant(
  id: string,
  fields: Partial<Pick<Tenant, "name" | "claim_value" | "accent">>
): void {
  const t = getTenant(id);
  if (!t) return;
  getDb()
    .prepare("UPDATE tenants SET name = ?, claim_value = ?, accent = ? WHERE id = ?")
    .run(
      fields.name?.trim() || t.name,
      fields.claim_value !== undefined ? fields.claim_value.trim() : t.claim_value,
      fields.accent !== undefined ? fields.accent : t.accent,
      id
    );
}

export function deleteTenant(id: string): void {
  const db = getDb();
  // Spaces come back to the library rather than vanishing with the tenant.
  // Deleting an organisational grouping must never delete anyone's writing.
  db.prepare("UPDATE spaces SET tenant_id = NULL WHERE tenant_id = ?").run(id);
  db.prepare("DELETE FROM tenant_members WHERE tenant_id = ?").run(id);
  db.prepare("DELETE FROM tenants WHERE id = ?").run(id);
}

/* ---- membership ---- */

export function addMember(tenantId: string, userId: string, fromClaim = false): void {
  getDb()
    .prepare(
      `INSERT INTO tenant_members (tenant_id, user_id, from_claim, added_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, user_id) DO UPDATE SET from_claim = excluded.from_claim`
    )
    .run(tenantId, userId, fromClaim ? 1 : 0, now());
}

export function removeMember(tenantId: string, userId: string): void {
  getDb()
    .prepare("DELETE FROM tenant_members WHERE tenant_id = ? AND user_id = ?")
    .run(tenantId, userId);
}

export function membersOf(tenantId: string): { id: string; name: string; email: string; from_claim: number }[] {
  return getDb()
    .prepare(
      `SELECT u.id, u.name, u.email, tm.from_claim
         FROM tenant_members tm JOIN users u ON u.id = tm.user_id
        WHERE tm.tenant_id = ? ORDER BY u.name`
    )
    .all(tenantId) as { id: string; name: string; email: string; from_claim: number }[];
}

/**
 * The tenants a principal belongs to.
 *
 * "all" for an instance admin, and for a signed-out reader — a stranger is
 * not inside any tenant, so they see the library, which is the untenanted
 * spaces and nothing else. That falls out of the scope rules rather than
 * needing a special case here.
 */
export function tenantIdsFor(user: User | null): "all" | string[] {
  if (!user) return [];
  if (user.role === "admin") return "all";
  return (
    getDb()
      .prepare("SELECT tenant_id FROM tenant_members WHERE user_id = ?")
      .all(user.id) as { tenant_id: string }[]
  ).map((r) => r.tenant_id);
}

/**
 * Reconcile tenant membership from the groups an identity provider asserted.
 *
 * Only memberships this mechanism created are removed. Somebody added by hand
 * stays added: a claim that stops appearing should not silently revoke access
 * an administrator granted deliberately.
 */
export function syncTenantsFromClaims(userId: string, claims: string[]): void {
  const db = getDb();
  const wanted = new Set(
    (db.prepare("SELECT id, claim_value FROM tenants").all() as Tenant[])
      .filter((t) => t.claim_value && claims.includes(t.claim_value))
      .map((t) => t.id)
  );
  const current = db
    .prepare("SELECT tenant_id, from_claim FROM tenant_members WHERE user_id = ?")
    .all(userId) as { tenant_id: string; from_claim: number }[];

  for (const row of current)
    if (row.from_claim === 1 && !wanted.has(row.tenant_id))
      removeMember(row.tenant_id, userId);
  for (const id of wanted) addMember(id, userId, true);
}

/** Put a space in a tenant, or back in the library with null. */
export function setSpaceTenant(spaceId: string, tenantId: string | null): void {
  getDb().prepare("UPDATE spaces SET tenant_id = ? WHERE id = ?").run(tenantId, spaceId);
}
