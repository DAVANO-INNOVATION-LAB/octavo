import "server-only";
import type { User } from "./auth";
import type { Page, Space } from "./data";
import { getDb } from "./db";
import { canEditSpace, canReadSpace } from "./roles";
import { isDeactivated } from "./scim";

/** New content-bearing notifications require current access to the actual page.
 * Historical inbox records are not rewritten by this delivery-time guard. */
export function canNotifyPage(
  userId: string,
  page: Pick<Page, "id" | "space_id" | "published">,
  space: Space,
): boolean {
  if (page.space_id !== space.id || isDeactivated(userId)) return false;
  const user = getDb().prepare("SELECT id, email, name, role FROM users WHERE id = ?")
    .get(userId) as User | undefined;
  return !!user && canReadSpace(user, space) &&
    (page.published === 1 || canEditSpace(user, space.id));
}
