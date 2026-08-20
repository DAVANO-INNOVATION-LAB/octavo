import "server-only";
import { getDb } from "./db";
import { getSetting } from "./settings";
import { newId, now } from "./util";

/**
 * Notifications.
 *
 * In-app delivery is the only channel that always works: no configuration, no
 * outbound network, nothing to fail on a disconnected instance. It is
 * therefore the one everything else is layered on — a webhook is a copy of a
 * notification that already exists, never the only record of it.
 *
 * Nobody is notified about their own actions. Being told you mentioned
 * yourself is noise, and noise is how people learn to ignore a bell.
 */

export type NotificationKind =
  | "mention"
  | "reply"
  | "cr.opened"
  | "cr.reviewed"
  | "cr.merged"
  | "cr.closed";

export type Notification = {
  id: string;
  user_id: string;
  kind: NotificationKind;
  actor_name: string;
  title: string;
  body: string;
  url: string;
  space_id: string | null;
  created_at: number;
  read_at: number | null;
};

/**
 * Deliver to one person. Returns false when nothing was written — because the
 * recipient is the actor, or the recipient does not exist.
 */
export function notify(input: {
  userId: string;
  actor: { id: string; name: string } | null;
  kind: NotificationKind;
  title: string;
  body?: string;
  url?: string;
  spaceId?: string | null;
}): boolean {
  if (!input.userId) return false;
  if (input.actor && input.actor.id === input.userId) return false;

  const row: Notification = {
    id: newId(),
    user_id: input.userId,
    kind: input.kind,
    actor_name: input.actor?.name ?? "",
    title: input.title.slice(0, 300),
    body: (input.body ?? "").slice(0, 1000),
    url: input.url ?? "",
    space_id: input.spaceId ?? null,
    created_at: now(),
    read_at: null,
  };

  try {
    getDb()
      .prepare(
        `INSERT INTO notifications
           (id, user_id, kind, actor_name, title, body, url, space_id, created_at, read_at)
         VALUES (@id, @user_id, @kind, @actor_name, @title, @body, @url, @space_id, @created_at, @read_at)`
      )
      .run(row);
  } catch (err) {
    console.error("notify: failed to record", input.kind, err);
    return false;
  }

  void postWebhook(row);
  return true;
}

/** Deliver the same notification to several people, skipping duplicates. */
export function notifyAll(
  userIds: string[],
  input: Omit<Parameters<typeof notify>[0], "userId">
): number {
  let sent = 0;
  for (const id of new Set(userIds)) {
    if (notify({ ...input, userId: id })) sent++;
  }
  return sent;
}

export function listNotifications(
  userId: string,
  opts: { unreadOnly?: boolean; limit?: number } = {}
): Notification[] {
  return getDb()
    .prepare(
      `SELECT * FROM notifications
       WHERE user_id = ?${opts.unreadOnly ? " AND read_at IS NULL" : ""}
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(userId, Math.min(opts.limit ?? 50, 200)) as Notification[];
}

export function unreadCount(userId: string): number {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL"
    )
    .get(userId) as { c: number };
  return row.c;
}

export function markRead(userId: string, id: string) {
  getDb()
    .prepare(
      "UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL"
    )
    .run(now(), id, userId);
}

export function markAllRead(userId: string) {
  getDb()
    .prepare(
      "UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL"
    )
    .run(now(), userId);
}

/**
 * Optional outbound copy, for Slack, Teams, or anything that accepts JSON.
 *
 * Deliberately fire-and-forget: a notification is already durable in the
 * database by the time this runs, so a webhook that is slow, wrong, or
 * unreachable must not delay or fail the action that caused it. On a
 * disconnected instance no URL is configured and nothing is attempted.
 */
async function postWebhook(n: Notification): Promise<void> {
  const url = getSetting("webhook_url");
  if (!url) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: n.kind,
        actor: n.actor_name,
        title: n.title,
        body: n.body,
        url: n.url,
        at: new Date(n.created_at).toISOString(),
        // Slack and Teams both render this field when present.
        text: `${n.actor_name ? `${n.actor_name}: ` : ""}${n.title}`,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    console.error("notify: webhook failed", (err as Error).message);
  }
}
