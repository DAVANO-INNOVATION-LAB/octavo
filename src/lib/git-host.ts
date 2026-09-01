import "server-only";

/**
 * Connecting a space to a Git repository, over the host's HTTP API.
 *
 * The sync engine already round-trips a space to a directory of Markdown, on
 * the stated principle that Octavo never runs Git: the runtime image has no
 * git binary and gains one only at the cost of its dependency surface. That
 * principle is kept here. This does not clone, shell out, or ask for a
 * sidecar — it reads and writes files through the same REST APIs a browser
 * would, so it works from a container with nothing installed in it.
 *
 * GitHub and GitLab differ in their URLs and in how they take a commit, and
 * in almost nothing else that matters. Both are expressed through one shape
 * so the space above does not care which it is talking to.
 *
 * Tokens are encrypted at rest with the same AES-256-GCM used for connector
 * credentials, and never leave the server.
 */

export type GitProvider = "github" | "gitlab";

export type RepoConnection = {
  provider: GitProvider;
  /** API base — api.github.com, or a self-hosted GitLab's /api/v4. */
  endpoint: string;
  /** "owner/name" for GitHub; the same for GitLab, url-encoded on the wire. */
  repo: string;
  branch: string;
  /** Directory within the repository. "" means the whole thing. */
  path: string;
  token: string;
};

export type RemoteFile = { path: string; sha: string };

export type Attempt<T> = { ok: true; value: T } | { ok: false; error: string };

const TIMEOUT = 20_000;

function apiBase(c: RepoConnection): string {
  const e = c.endpoint.replace(/\/+$/, "");
  if (c.provider === "github") return e || "https://api.github.com";
  return (e || "https://gitlab.com").endsWith("/api/v4") ? e : `${e || "https://gitlab.com"}/api/v4`;
}

function headers(c: RepoConnection): Record<string, string> {
  return c.provider === "github"
    ? {
        Authorization: `Bearer ${c.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      }
    : { "PRIVATE-TOKEN": c.token };
}

/** GitLab addresses a project by its url-encoded full path. */
const projectId = (repo: string) => encodeURIComponent(repo);

async function call(
  url: string,
  init: RequestInit & { headers: Record<string, string> }
): Promise<Attempt<{ status: number; text: string }>> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
    const text = await res.text();
    if (!res.ok)
      return {
        ok: false,
        error: `the host answered HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      };
    return { ok: true, value: { status: res.status, text } };
  } catch (err) {
    // A wrong host, an offline instance, an expired certificate: all arrive
    // here, and the person about to retry needs to know which.
    return {
      ok: false,
      error: err instanceof Error ? err.message : "the request did not complete",
    };
  }
}

/**
 * Does this connection work, and does the branch exist?
 *
 * Checked before anything is written, because the failure people actually hit
 * is a token missing one scope, and finding that out halfway through a commit
 * is how a space ends up half-pushed.
 */
export async function verifyConnection(c: RepoConnection): Promise<Attempt<{ branch: string }>> {
  const url =
    c.provider === "github"
      ? `${apiBase(c)}/repos/${c.repo}/branches/${encodeURIComponent(c.branch)}`
      : `${apiBase(c)}/projects/${projectId(c.repo)}/repository/branches/${encodeURIComponent(c.branch)}`;
  const r = await call(url, { headers: headers(c) });
  if (!r.ok) return r;
  return { ok: true, value: { branch: c.branch } };
}

/** Every Markdown file under the configured path, at the configured branch. */
export async function listMarkdown(c: RepoConnection): Promise<Attempt<RemoteFile[]>> {
  const prefix = c.path.replace(/^\/+|\/+$/g, "");
  if (c.provider === "github") {
    const r = await call(
      `${apiBase(c)}/repos/${c.repo}/git/trees/${encodeURIComponent(c.branch)}?recursive=1`,
      { headers: headers(c) }
    );
    if (!r.ok) return r;
    const tree = JSON.parse(r.value.text) as {
      truncated?: boolean;
      tree?: { path: string; type: string; sha: string }[];
    };
    // A truncated tree would silently sync a subset and then delete the rest
    // as "removed upstream". Refusing is the only safe answer.
    if (tree.truncated)
      return { ok: false, error: "the repository tree is too large to list in one request" };
    const files = (tree.tree ?? [])
      .filter((n) => n.type === "blob" && /\.md$/i.test(n.path))
      .filter((n) => (prefix ? n.path.startsWith(`${prefix}/`) : true))
      .map((n) => ({ path: prefix ? n.path.slice(prefix.length + 1) : n.path, sha: n.sha }));
    return { ok: true, value: files };
  }

  const out: RemoteFile[] = [];
  for (let page = 1; page <= 20; page++) {
    const url =
      `${apiBase(c)}/projects/${projectId(c.repo)}/repository/tree` +
      `?ref=${encodeURIComponent(c.branch)}&recursive=true&per_page=100&page=${page}` +
      (prefix ? `&path=${encodeURIComponent(prefix)}` : "");
    const r = await call(url, { headers: headers(c) });
    if (!r.ok) return r;
    const nodes = JSON.parse(r.value.text) as { path: string; type: string; id: string }[];
    if (nodes.length === 0) break;
    for (const n of nodes) {
      if (n.type !== "blob" || !/\.md$/i.test(n.path)) continue;
      out.push({ path: prefix ? n.path.slice(prefix.length + 1) : n.path, sha: n.id });
    }
    if (nodes.length < 100) break;
  }
  return { ok: true, value: out };
}

/** One file's text. */
export async function readFile(c: RepoConnection, rel: string): Promise<Attempt<string>> {
  const prefix = c.path.replace(/^\/+|\/+$/g, "");
  const full = prefix ? `${prefix}/${rel}` : rel;
  if (c.provider === "github") {
    const r = await call(
      `${apiBase(c)}/repos/${c.repo}/contents/${encodePath(full)}?ref=${encodeURIComponent(c.branch)}`,
      { headers: headers(c) }
    );
    if (!r.ok) return r;
    const body = JSON.parse(r.value.text) as { content?: string; encoding?: string };
    if (body.encoding !== "base64" || typeof body.content !== "string")
      return { ok: false, error: "the host returned no readable content" };
    return { ok: true, value: Buffer.from(body.content, "base64").toString("utf8") };
  }
  const r = await call(
    `${apiBase(c)}/projects/${projectId(c.repo)}/repository/files/${encodeURIComponent(full)}/raw` +
      `?ref=${encodeURIComponent(c.branch)}`,
    { headers: headers(c) }
  );
  if (!r.ok) return r;
  return { ok: true, value: r.value.text };
}

export type Change = { path: string; content: string };

/**
 * Write files back as one commit.
 *
 * One commit, not one per file: a space pushed as forty commits is unreadable
 * history, and half of it landing is a repository in a state nobody chose.
 * GitHub takes a batch through its commits API; GitLab takes one through its
 * actions API — the same guarantee either way.
 */
export async function pushFiles(
  c: RepoConnection,
  changes: Change[],
  message: string
): Promise<Attempt<{ commit: string; files: number }>> {
  if (changes.length === 0) return { ok: true, value: { commit: "", files: 0 } };
  const prefix = c.path.replace(/^\/+|\/+$/g, "");
  const full = (rel: string) => (prefix ? `${prefix}/${rel}` : rel);

  if (c.provider === "gitlab") {
    const existing = await listMarkdown(c);
    if (!existing.ok) return existing;
    const known = new Set(existing.value.map((f) => f.path));
    const body = {
      branch: c.branch,
      commit_message: message,
      actions: changes.map((ch) => ({
        action: known.has(ch.path) ? "update" : "create",
        file_path: full(ch.path),
        content: ch.content,
      })),
    };
    const r = await call(`${apiBase(c)}/projects/${projectId(c.repo)}/repository/commits`, {
      method: "POST",
      headers: { ...headers(c), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return r;
    const made = JSON.parse(r.value.text) as { id?: string };
    return { ok: true, value: { commit: made.id ?? "", files: changes.length } };
  }

  // GitHub: read the branch head, build a tree on top of it, commit, move the
  // ref. Blobs are sent as base64 so content that is not valid UTF-8 — or is
  // merely awkward — survives the round trip.
  const base = apiBase(c);
  const head = await call(
    `${base}/repos/${c.repo}/git/ref/heads/${encodeURIComponent(c.branch)}`,
    { headers: headers(c) }
  );
  if (!head.ok) return head;
  const headSha = (JSON.parse(head.value.text) as { object?: { sha?: string } }).object?.sha;
  if (!headSha) return { ok: false, error: "the branch has no commit to build on" };

  const blobs: { path: string; sha: string }[] = [];
  for (const ch of changes) {
    const r = await call(`${base}/repos/${c.repo}/git/blobs`, {
      method: "POST",
      headers: { ...headers(c), "Content-Type": "application/json" },
      body: JSON.stringify({
        content: Buffer.from(ch.content, "utf8").toString("base64"),
        encoding: "base64",
      }),
    });
    if (!r.ok) return r;
    blobs.push({ path: full(ch.path), sha: (JSON.parse(r.value.text) as { sha: string }).sha });
  }

  const tree = await call(`${base}/repos/${c.repo}/git/trees`, {
    method: "POST",
    headers: { ...headers(c), "Content-Type": "application/json" },
    body: JSON.stringify({
      base_tree: headSha,
      tree: blobs.map((b) => ({ path: b.path, mode: "100644", type: "blob", sha: b.sha })),
    }),
  });
  if (!tree.ok) return tree;
  const treeSha = (JSON.parse(tree.value.text) as { sha: string }).sha;

  const commit = await call(`${base}/repos/${c.repo}/git/commits`, {
    method: "POST",
    headers: { ...headers(c), "Content-Type": "application/json" },
    body: JSON.stringify({ message, tree: treeSha, parents: [headSha] }),
  });
  if (!commit.ok) return commit;
  const commitSha = (JSON.parse(commit.value.text) as { sha: string }).sha;

  const move = await call(
    `${base}/repos/${c.repo}/git/refs/heads/${encodeURIComponent(c.branch)}`,
    {
      method: "PATCH",
      headers: { ...headers(c), "Content-Type": "application/json" },
      body: JSON.stringify({ sha: commitSha }),
    }
  );
  if (!move.ok) return move;
  return { ok: true, value: { commit: commitSha, files: changes.length } };
}

/** Percent-encode a path without destroying its separators. */
function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

/** A browsable URL for a file, so the UI can link at what it synced. */
export function fileUrl(c: RepoConnection, rel: string): string {
  const prefix = c.path.replace(/^\/+|\/+$/g, "");
  const full = prefix ? `${prefix}/${rel}` : rel;
  const host =
    c.provider === "github"
      ? apiBase(c).replace(/^https:\/\/api\./, "https://").replace(/\/api\/v3$/, "")
      : apiBase(c).replace(/\/api\/v4$/, "");
  return c.provider === "github"
    ? `${host}/${c.repo}/blob/${c.branch}/${encodePath(full)}`
    : `${host}/${c.repo}/-/blob/${c.branch}/${encodePath(full)}`;
}
