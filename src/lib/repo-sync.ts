import "server-only";
import { getDb } from "./db";
import { decryptSecret, encryptSecret } from "./crypto";
import { now } from "./util";
import { getPage, type Space } from "./data";
import { planSync, type FileSide, type SyncState } from "./sync";
import { collectPages, pageToMarkdown, sha } from "./sync-io";
import {
  listMarkdown,
  pushFiles,
  readFile,
  verifyConnection,
  type Change,
  type GitProvider,
  type RepoConnection,
} from "./git-host";
import { importMarkdownEntries } from "./transfer";

/**
 * Syncing a space with a repository.
 *
 * The hard part of any sync is attribution — deciding which side changed —
 * and that is already solved by `planSync`, which is pure and heavily tested
 * because sync bugs destroy writing and do it silently. This module's whole
 * job is to describe a remote repository in the terms that planner already
 * understands, so the same reasoning applies whether the other side is a
 * directory on disk or a branch on GitHub.
 *
 * What it deliberately does not do is resolve a conflict. When both sides
 * moved, both are reported and neither is touched.
 */

export type RepoSettings = {
  provider: GitProvider;
  endpoint: string;
  repo: string;
  branch: string;
  path: string;
  /** Present only when read for use; never returned to a browser. */
  token: string;
  lastSynced: number;
  lastResult: string;
};

type Row = {
  space_id: string;
  provider: string;
  endpoint: string;
  repo: string;
  branch: string;
  path: string;
  token: string;
  last_synced: number;
  last_result: string;
};

export function getRepoSettings(spaceId: string): RepoSettings | null {
  const row = getDb()
    .prepare("SELECT * FROM space_repos WHERE space_id = ?")
    .get(spaceId) as Row | undefined;
  if (!row) return null;
  return {
    provider: row.provider === "gitlab" ? "gitlab" : "github",
    endpoint: row.endpoint,
    repo: row.repo,
    branch: row.branch || "main",
    path: row.path,
    token: decryptSecret(row.token),
    lastSynced: row.last_synced,
    lastResult: row.last_result,
  };
}

export function saveRepoSettings(
  spaceId: string,
  s: Omit<RepoSettings, "lastSynced" | "lastResult">
): void {
  const existing = getRepoSettings(spaceId);
  // A blank token means "leave the stored one alone", so reconfiguring a
  // branch does not silently clear the credential.
  const token = s.token ? encryptSecret(s.token) : existing ? encryptSecret(existing.token) : "";
  getDb()
    .prepare(
      `INSERT INTO space_repos (space_id, provider, endpoint, repo, branch, path, token, last_synced, last_result)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, '')
       ON CONFLICT(space_id) DO UPDATE SET
         provider = excluded.provider, endpoint = excluded.endpoint, repo = excluded.repo,
         branch = excluded.branch, path = excluded.path, token = excluded.token`
    )
    .run(spaceId, s.provider, s.endpoint, s.repo, s.branch || "main", s.path, token);
}

export function forgetRepo(spaceId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM space_repos WHERE space_id = ?").run(spaceId);
  db.prepare("DELETE FROM repo_state WHERE space_id = ?").run(spaceId);
}

export function connectionFor(s: RepoSettings): RepoConnection {
  return {
    provider: s.provider,
    endpoint: s.endpoint,
    repo: s.repo,
    branch: s.branch,
    path: s.path,
    token: s.token,
  };
}

function readRepoState(spaceId: string): SyncState[] {
  return getDb()
    .prepare("SELECT path, page_id AS pageId, hash FROM repo_state WHERE space_id = ?")
    .all(spaceId) as SyncState[];
}

function putRepoState(spaceId: string, s: SyncState): void {
  getDb()
    .prepare(
      `INSERT INTO repo_state (space_id, path, page_id, hash, synced_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(space_id, path) DO UPDATE SET
         page_id = excluded.page_id, hash = excluded.hash, synced_at = excluded.synced_at`
    )
    .run(spaceId, s.path, s.pageId, s.hash, now());
}

export type RepoReport = {
  pushed: number;
  pulled: number;
  conflicts: { path: string; why: string }[];
  unchanged: number;
  commit: string;
  error?: string;
};

export async function verify(s: RepoSettings): Promise<{ ok: boolean; error?: string }> {
  const r = await verifyConnection(connectionFor(s));
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/**
 * Bring a space and a branch into agreement.
 *
 * Every remote file is fetched before anything is decided, because the
 * planner needs both sides whole: acting on a partial listing would read a
 * file that failed to download as a file that was deleted upstream, and
 * delete the page.
 */
export async function syncWithRepo(space: Space): Promise<RepoReport> {
  const empty: RepoReport = { pushed: 0, pulled: 0, conflicts: [], unchanged: 0, commit: "" };
  const settings = getRepoSettings(space.id);
  if (!settings) return { ...empty, error: "no repository is connected to this space" };
  const conn = connectionFor(settings);

  const listed = await listMarkdown(conn);
  if (!listed.ok) return { ...empty, error: listed.error };

  const remote: FileSide[] = [];
  const bodies = new Map<string, string>();
  for (const f of listed.value) {
    const body = await readFile(conn, f.path);
    if (!body.ok) return { ...empty, error: `${f.path}: ${body.error}` };
    bodies.set(f.path, body.value);
    const title = /^---[\s\S]*?\btitle:\s*"?([^"\n]+)"?/.exec(body.value)?.[1]?.trim();
    remote.push({
      path: f.path,
      title: title ?? f.path.replace(/\.md$/i, ""),
      hash: sha(body.value),
    });
  }

  const pages = collectPages(space);
  const plan = planSync(pages, remote, readRepoState(space.id));

  const changes: Change[] = [];
  const pulled: { name: string; data: Buffer }[] = [];
  const conflicts: { path: string; why: string }[] = [];

  for (const a of plan.actions) {
    if (a.kind === "write") {
      const page = getPage(a.pageId);
      if (!page) continue;
      changes.push({ path: a.path, content: pageToMarkdown(page) });
    } else if (a.kind === "import") {
      const body = bodies.get(a.path);
      if (body !== undefined) pulled.push({ name: a.path, data: Buffer.from(body, "utf8") });
    } else if (a.kind === "conflict") {
      conflicts.push({ path: a.path, why: a.why });
    }
    // "delete-file" and "orphan-page" are deliberately not acted on here.
    // Deleting someone's file or page because a sync said so is the one
    // mistake that cannot be undone from inside Octavo.
  }

  let commit = "";
  if (changes.length > 0) {
    const pushedResult = await pushFiles(
      conn,
      changes,
      `Update ${changes.length} page${changes.length === 1 ? "" : "s"} from ${space.name}`
    );
    if (!pushedResult.ok) return { ...empty, error: pushedResult.error };
    commit = pushedResult.value.commit;
    for (const ch of changes) {
      const action = plan.actions.find((a) => a.kind === "write" && a.path === ch.path);
      if (action && "pageId" in action && action.pageId)
        putRepoState(space.id, { path: ch.path, pageId: action.pageId, hash: sha(ch.content) });
    }
  }

  if (pulled.length > 0) {
    // The markdown importer owns turning files into pages; there is one
    // implementation of "what does this file mean" and this is not it.
    importMarkdownEntries(pulled, `${space.name} — from ${settings.repo}`);
  }

  getDb()
    .prepare("UPDATE space_repos SET last_synced = ?, last_result = ? WHERE space_id = ?")
    .run(
      now(),
      `${changes.length} pushed, ${pulled.length} pulled${conflicts.length ? `, ${conflicts.length} in conflict` : ""}`,
      space.id
    );

  return {
    pushed: changes.length,
    pulled: pulled.length,
    conflicts,
    unchanged: plan.unchanged,
    commit,
  };
}
