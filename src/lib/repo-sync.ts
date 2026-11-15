import { collaborationEnabled } from "./collab-config";
import "server-only";
import { getDb } from "./db";
import { decryptSecret, encryptSecret } from "./crypto";
import { now, newId } from "./util";
import { createPage, getPage, savePage, type Space } from "./data";
import { type SyncState } from "./sync";
import { blocksToMarkdown, markdownToBlocks, splitFrontmatter } from "./markdown";
import { createMarkdownPageLinkRewriter } from "./markdown-page-links";
import { repoSemantic as semantic } from "./repo-content";
import { pageRevision } from "./page-revisions";
type SharedReconciler = typeof import("./repo-collab");
import { collectPages, pageToMarkdown, sha } from "./sync-io";
import {
  listMarkdown,
  resolveRevision,
  pushFiles,
  readFile,
  verifyConnection,
  type Change,
  type GitProvider,
  type RepoConnection,
} from "./git-host";
import { importMarkdownEntries } from "./transfer";

/** Repository reconciliation is separate from snapshot replication. It preserves
 * bound page identities, stages a pinned remote revision, and fails closed on
 * concurrent changes. It is not disconnected multi-writer synchronization. */

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
    provider: row.provider === "bitbucket-dc" ? "bitbucket-dc" : row.provider === "bitbucket" ? "bitbucket" : row.provider === "gitlab" ? "gitlab" : "github",
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
  const db = getDb();
  db.transaction(() => {
  if (existing && ["provider", "endpoint", "repo", "branch", "path"].some(key => existing[key as keyof RepoSettings] !== (key === "branch" ? s.branch || "main" : s[key as keyof typeof s]))) {
    db.prepare("DELETE FROM repo_state WHERE space_id = ?").run(spaceId);
    db.prepare("DELETE FROM repo_sync_baselines WHERE space_id = ?").run(spaceId);
    db.prepare("DELETE FROM repo_sync_reports WHERE space_id = ?").run(spaceId);
  }
  db.prepare(
      `INSERT INTO space_repos (space_id, provider, endpoint, repo, branch, path, token, last_synced, last_result)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, '')
       ON CONFLICT(space_id) DO UPDATE SET
         provider = excluded.provider, endpoint = excluded.endpoint, repo = excluded.repo,
         branch = excluded.branch, path = excluded.path, token = excluded.token`
    )
    .run(spaceId, s.provider, s.endpoint, s.repo, s.branch || "main", s.path, token);
  })();
}

export function forgetRepo(spaceId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM space_repos WHERE space_id = ?").run(spaceId);
  db.prepare("DELETE FROM repo_state WHERE space_id = ?").run(spaceId);
  db.prepare("DELETE FROM repo_sync_baselines WHERE space_id = ?").run(spaceId);
  db.prepare("DELETE FROM repo_sync_reports WHERE space_id = ?").run(spaceId);
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

export type RepoReport = {
  pushed: number;
  pulled: number;
  conflicts: { path: string; why: string }[];
  unchanged: number;
  commit: string;
  error?: string;
  importedSpace?: string;
};

export async function verify(s: RepoSettings): Promise<{ ok: boolean; error?: string }> {
  const r = await verifyConnection(connectionFor(s));
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

type Baseline = { path: string; pageId: string; localPath: string; localHash: string; remoteHash: string };
function readBaselines(spaceId: string): Baseline[] {
  const rows = getDb().prepare(`SELECT path, page_id AS pageId, local_path AS localPath,
    local_hash AS localHash, remote_hash AS remoteHash FROM repo_sync_baselines WHERE space_id = ? ORDER BY path`).all(spaceId) as Baseline[];
  const paths = new Set(rows.map(r => r.path));
  // Upgrade old one-hash records conservatively, without forgetting attribution.
  for (const old of readRepoState(spaceId)) if (!paths.has(old.path)) rows.push({
    path: old.path, pageId: old.pageId, localPath: old.path, localHash: old.hash, remoteHash: old.hash,
  });
  return rows.sort((a,b) => a.path.localeCompare(b.path));
}
function putBaseline(spaceId: string, row: Baseline) {
  getDb().prepare(`INSERT INTO repo_sync_baselines (space_id,path,page_id,local_path,local_hash,remote_hash)
    VALUES (?,?,?,?,?,?) ON CONFLICT(space_id,path) DO UPDATE SET page_id=excluded.page_id,
    local_path=excluded.local_path,local_hash=excluded.local_hash,remote_hash=excluded.remote_hash`)
    .run(spaceId,row.path,row.pageId,row.localPath,row.localHash,row.remoteHash);
}
export function getLastRepoReport(spaceId: string): RepoReport | null {
  const row = getDb().prepare("SELECT report FROM repo_sync_reports WHERE space_id = ?").get(spaceId) as {report: string} | undefined;
  if (!row) return null;
  try { return JSON.parse(row.report) as RepoReport; } catch { return null; }
}
function pullSafety(pageId: string, shared: SharedReconciler | null): string | null {
  const page = getPage(pageId);
  if (!page) return "Bound page is missing";
  const db = getDb();
  // The shared Yjs document is the editor's source of truth. Updating only the
  // page JSON would leave persisted or active collaboration state stale. Until
  // there is an epoch-aware Yjs reconciliation protocol, never replace it.
  if (collaborationEnabled() || db.prepare("SELECT 1 FROM collab_docs WHERE page_id=?").get(pageId)) {
    if (!shared)
      return "Collaborative editor state cannot be reconciled safely; remote changes require explicit review. No shared document was reset.";
    const unsafe = shared.sharedDocumentSafety(pageId,page.content);
    if (unsafe) return unsafe;
  }
  if (db.prepare("SELECT 1 FROM comments WHERE page_id=? AND block_id<>'' LIMIT 1").get(pageId) ||
      db.prepare("SELECT 1 FROM highlights WHERE page_id=? LIMIT 1").get(pageId) ||
      db.prepare("SELECT 1 FROM runs WHERE page_id=? LIMIT 1").get(pageId))
    return "Page has block-anchored comments, highlights or runs; remote changes require explicit review.";
  try {
    const blocks = JSON.parse(page.content);
    if (!Array.isArray(blocks) || semantic(blocks) !== semantic(markdownToBlocks(blocksToMarkdown(blocks))))
      return "Page contains editor data that Markdown cannot preserve; remote changes require explicit review.";
  } catch { return "Page content cannot be safely round-tripped; remote changes require explicit review."; }
  return null;
}
function preserveUnchangedIds(previous: unknown[], incoming: unknown[]): unknown[] {
  const ids = new Map<string,string|null>();
  const walk = (items: unknown[], save: boolean) => {
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const block = item as {id?:string;children?:unknown[]};
      const key = semantic(item);
      if (save && block.id) ids.set(key,ids.has(key)?null:block.id);
      else if (!save && ids.get(key)) { block.id=ids.get(key)!; ids.delete(key); }
      if (block.children) walk(block.children,save);
    }
  };
  walk(previous,true);walk(incoming,false);return incoming;
}
const active = new Set<string>();
const safePath = (p: string) => p.length > 0 && !p.startsWith("/") && !p.includes("\\") && p.split("/").every(x => x && x !== "." && x !== "..");

export async function syncWithRepo(space: Space, actorId?: string): Promise<RepoReport> {
  const report: RepoReport = { pushed: 0, pulled: 0, conflicts: [], unchanged: 0, commit: "" };
  if (active.has(space.id)) return {...report, error: "A repository sync is already running for this space"};
  active.add(space.id);
  try {
    // Keep experimental editor dependencies out of ordinary actions and sync.
    const shared = process.env.OCTAVO_REPO_COLLAB_SYNC === "experimental" ? await import("./repo-collab") : null;
    const settings = getRepoSettings(space.id);
    if (!settings) return {...report, error: "no repository is connected to this space"};
    const conn = connectionFor(settings);
    const connectionStamp = JSON.stringify(conn);
    const pages = collectPages(space);
    const capturePages = () => JSON.stringify(collectPages(space).map(p => getPage(p.id)));
    const pageStamp = capturePages();
    const baseline = readBaselines(space.id);
    const baselineStamp = JSON.stringify(baseline);
    if (new Set(baseline.map(b => b.pageId)).size !== baseline.length)
      return {...report,error:"Ambiguous repository bindings refer to one page more than once; nothing applied"};
    const assertUnchanged = () => {
      const current = getRepoSettings(space.id);
      if (!current || JSON.stringify(connectionFor(current)) !== connectionStamp || capturePages() !== pageStamp || JSON.stringify(readBaselines(space.id)) !== baselineStamp)
        throw new Error("Local pages, sync state or connection changed during sync. Retry; no local changes applied.");
    };
    const revision = await resolveRevision(conn);
    if (!revision.ok) return {...report, error: revision.error};
    const pinned = {...conn, branch: revision.value};
    const listed = await listMarkdown(pinned);
    if (!listed.ok) return {...report, error: listed.error};
    const bodies = new Map<string,string>();
    for (const file of listed.value) {
      if (!safePath(file.path) || bodies.has(file.path)) return {...report, error: "Invalid or duplicate repository path; nothing applied"};
      const body = await readFile(pinned, file.path);
      if (!body.ok) return {...report, error: `${file.path}: ${body.error}`};
      bodies.set(file.path, body.value);
    }
    if (settings.provider === "bitbucket-dc") {
      // Data Center retains its explicitly labeled snapshot-import workflow.
      if (!bodies.size) return {...report,error:"No Markdown files found in the configured directory"};
      return getDb().transaction(() => {
        assertUnchanged();
        const imported = importMarkdownEntries([...bodies].map(([name,body])=>({name,data:Buffer.from(body)})), `${space.name} — Data Center snapshot`);
        const result = {...report,pulled:imported.pages,importedSpace:imported.spaceSlug};
        getDb().prepare("UPDATE space_repos SET last_synced=?,last_result=? WHERE space_id=?")
          .run(now(),`${imported.pages} pages imported into ${imported.spaceSlug}`,space.id);
        getDb().prepare("INSERT INTO repo_sync_reports(space_id,report) VALUES(?,?) ON CONFLICT(space_id) DO UPDATE SET report=excluded.report")
          .run(space.id,JSON.stringify(result));
        return result;
      })();
    }
    const local = new Map(pages.map(p => [p.id,p]));
    const boundIds = new Set(baseline.map(b => b.pageId));
    const known = new Set(baseline.map(b => b.path));
    const pending = baseline.some(b => !bodies.has(b.path) || !local.has(b.pageId));
    const writes: Change[] = [];
    const pulls: {path:string;pageId?:string;title:string;content:string}[] = [];
    const checkpoints: {path:string;pageId:string;remoteHash:string}[] = [];
    const conflict = (path:string,why:string) => report.conflicts.push({path,why});
    const queuePull = (path:string,pageId?:string) => {
      if (pageId) { const unsafe = pullSafety(pageId,shared); if (unsafe) { conflict(path,unsafe); return; } }
      const [meta,body] = splitFrontmatter(bodies.get(path)!);
      // Publishing is a separate authorized action; pull never changes visibility.
      pulls.push({path,pageId,title:meta.title || path.split("/").pop()!.replace(/\.md$/i,""),content:JSON.stringify(markdownToBlocks(body))});
    };
    for (const b of baseline) {
      const page = local.get(b.pageId), raw = bodies.get(b.path);
      if (!page || raw === undefined) {
        conflict(b.path,!page ? "Bound page was deleted; remote file retained. Resolve deletion or move explicitly." : "Remote file is missing; original page retained. Resolve deletion or move explicitly.");
        continue;
      }
      if (page.path !== b.localPath) { conflict(b.path,"Page moved or renamed locally; binding retained, explicit reconciliation required."); continue; }
      const rh = sha(raw), lc = page.hash !== b.localHash, rc = rh !== b.remoteHash;
      if (page.hash === rh || (!lc && !rc)) {
        report.unchanged++; checkpoints.push({path:b.path,pageId:page.id,remoteHash:rh});
      } else if (lc && rc) conflict(b.path,"Both page and repository changed; neither overwritten.");
      else if (lc) { writes.push({path:b.path,content:pageToMarkdown(getPage(page.id)!)}); checkpoints.push({path:b.path,pageId:page.id,remoteHash:page.hash}); }
      else queuePull(b.path,page.id);
    }
    const unbound = pages.filter(p => !boundIds.has(p.id));
    const pathCounts = new Map<string,number>();
    for (const p of unbound) pathCounts.set(p.path,(pathCounts.get(p.path) ?? 0)+1);
    for (const page of unbound) {
      if (!safePath(page.path) || pathCounts.get(page.path)! > 1 || known.has(page.path)) { conflict(page.path,"Ambiguous page path; no file written."); continue; }
      const raw = bodies.get(page.path);
      known.add(page.path);
      if (raw !== undefined && sha(raw) === page.hash) { report.unchanged++; checkpoints.push({path:page.path,pageId:page.id,remoteHash:page.hash}); }
      else if (raw !== undefined) conflict(page.path,"Page and file differ without a common baseline; neither overwritten.");
      else if (pending) conflict(page.path,"Unresolved deletion or move exists; new page export held to avoid duplicate identities.");
      else { writes.push({path:page.path,content:pageToMarkdown(getPage(page.id)!)}); checkpoints.push({path:page.path,pageId:page.id,remoteHash:page.hash}); }
    }
    for (const path of bodies.keys()) if (!known.has(path)) {
      if (pending) conflict(path,"Unresolved deletion or move exists; new file import held to avoid duplicate identities.");
      else queuePull(path);
    }
    assertUnchanged();
    if (writes.length) {
      const pushed = await pushFiles(conn,writes,`Update ${writes.length} pages from ${space.name}`,revision.value);
      if (!pushed.ok) return {...report,error:pushed.error};
      report.commit = pushed.value.commit;
      report.pushed = writes.length;
    }
    getDb().transaction(() => {
      assertUnchanged();
      const importedPages = new Map<string,string>();
      for (const pull of pulls) {
        const existing = pull.pageId ? getPage(pull.pageId) : null;
        if (existing) { const unsafe = pullSafety(existing.id,shared); if (unsafe) throw new Error(unsafe); }
        if (existing && existing.space_id !== space.id) throw new Error("Repository binding refers to another space; nothing applied");
        if (existing) {
          const version = pageRevision(existing.id);
          const shared = getDb().prepare("SELECT state FROM collab_docs WHERE page_id=?").get(existing.id) as {state:Buffer}|undefined;
          getDb().prepare("INSERT INTO repo_sync_revisions(id,page_id,page_json,remote_revision,collab_state,collab_epoch,page_revision,created_at) VALUES(?,?,?,?,?,?,?,?)")
            .run(newId(),existing.id,JSON.stringify(existing),revision.value,shared?.state ?? null,version.epoch,version.revision,now());
        }
        const page = existing ?? createPage({spaceId:space.id,title:pull.title});
        // Keep existing hierarchy, ID and publication state. New imports are drafts.
        savePage(page.id,{title:pull.title,by:actorId});
        importedPages.set(pull.path,page.id);
        checkpoints.push({path:pull.path,pageId:page.id,remoteHash:sha(bodies.get(pull.path)!)});
      }
      const destinations = [...baseline,...checkpoints].flatMap(c => {
        const page = getPage(c.pageId);
        return page && page.space_id === space.id ? [{sourcePath:c.path,href:`/${space.slug}/${page.slug}`}] : [];
      });
      const rewrite = createMarkdownPageLinkRewriter(destinations);
      for (const pull of pulls) {
        const id = importedPages.get(pull.path)!;
        const blocks = preserveUnchangedIds(JSON.parse(getPage(id)!.content),rewrite(JSON.parse(pull.content),pull.path));
        savePage(id,{content:JSON.stringify(blocks),by:actorId});
        if (shared)
          shared.replaceSharedDocument(id,shared.materializeRepoDocument(blocks));
      }
      const after = new Map(collectPages(space).map(p => [p.id,p]));
      for (const c of checkpoints) {
        const p = after.get(c.pageId);
        if (!p) throw new Error("Page disappeared before sync checkpoint");
        putBaseline(space.id,{...c,localHash:p.hash,localPath:p.path});
      }
      report.pulled = pulls.length;
      getDb().prepare("UPDATE space_repos SET last_synced=?,last_result=? WHERE space_id=?")
        .run(now(),`${report.pushed} pushed, ${report.pulled} pulled, ${report.conflicts.length} unresolved`,space.id);
      getDb().prepare("INSERT INTO repo_sync_reports(space_id,report) VALUES(?,?) ON CONFLICT(space_id) DO UPDATE SET report=excluded.report")
        .run(space.id,JSON.stringify(report));
    })();
    return report;
  } catch (e) {
    report.pulled = 0;
    return {...report,error: `${e instanceof Error ? e.message : "Repository sync failed"}${report.commit ? ` Remote commit ${report.commit} succeeded; local application did not complete. Retry to reassess; conflicting changes may require manual resolution.` : ""}`};
  } finally { active.delete(space.id); }
}
