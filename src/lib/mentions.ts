/**
 * @-mentions inside comment bodies.
 *
 * Mentions are not stored as markup. The body stays the text the author
 * typed, and names are resolved when the comment is rendered, so a person
 * who changes their display name is still addressed correctly afterwards
 * and an unmatched "@" never becomes a broken link.
 *
 * Display names may contain spaces, so matching tries the longest known name
 * first: with both "Ada" and "Ada Lovelace" on the instance, "@Ada Lovelace"
 * resolves to the person actually meant.
 */

export type MentionUser = { id: string; name: string };

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "mention"; text: string; user: MentionUser };

/** Characters that may sit directly before an "@" for it to start a mention. */
function boundaryBefore(body: string, i: number): boolean {
  if (i === 0) return true;
  return /[\s([{<"'—–-]/.test(body[i - 1]);
}

/**
 * Split a comment body into plain text and resolved mentions.
 * Unknown names are left as ordinary text rather than guessed at.
 */
export function parseMentions(body: string, users: MentionUser[]): Segment[] {
  if (!body.includes("@") || users.length === 0) {
    return body ? [{ kind: "text", text: body }] : [];
  }
  // Longest first so "Ada Lovelace" wins over "Ada".
  const ordered = [...users].sort((a, b) => b.name.length - a.name.length);
  const lower = body.toLowerCase();

  const out: Segment[] = [];
  let plain = "";
  let i = 0;

  while (i < body.length) {
    if (body[i] !== "@" || !boundaryBefore(body, i)) {
      plain += body[i];
      i++;
      continue;
    }
    const hit = ordered.find((u) => {
      const name = u.name.toLowerCase();
      if (!name) return false;
      if (!lower.startsWith(name, i + 1)) return false;
      // Do not match a prefix of a longer word: "@dev" must not fire on "@developer".
      const after = body[i + 1 + name.length];
      return after === undefined || !/[\w]/.test(after);
    });
    if (!hit) {
      plain += body[i];
      i++;
      continue;
    }
    if (plain) {
      out.push({ kind: "text", text: plain });
      plain = "";
    }
    out.push({
      kind: "mention",
      text: `@${body.slice(i + 1, i + 1 + hit.name.length)}`,
      user: hit,
    });
    i += 1 + hit.name.length;
  }
  if (plain) out.push({ kind: "text", text: plain });
  return out;
}

/** The distinct people addressed in a body — what a notifier would send to. */
export function mentionedUserIds(body: string, users: MentionUser[]): string[] {
  const ids = new Set<string>();
  for (const seg of parseMentions(body, users)) {
    if (seg.kind === "mention") ids.add(seg.user.id);
  }
  return [...ids];
}
