# Repository reconciliation

The v0.28.0-rc.1 evaluation candidate separates repository round trips from snapshot replication. It does not
implement independent, disconnected, multi-writer sites.

## Supported behavior

- GitHub: immutable-revision reads and non-force commits based on the inspected
  branch head. A preflight head mismatch or intervening forward commit aborts
  rather than force-overwriting it. This REST guard is not strict compare-and-swap
  against forced rewinds or an ABA head change. Do not use branches subject to
  concurrent forced rewrites; strict expected-head mutation remains a follow-up.
- GitLab / Bitbucket Cloud: immutable-revision reads. **Outbound changes are held**
  because this release does not establish the provider's required conditional-write
  guarantee. If outbound changes are planned, the whole attempt stops before local
  application. Use the existing external Git workflow until guarded commits land.
- Bitbucket Data Center: explicitly separate, new-private-space snapshot imports.
  Repeated snapshots are intentionally separate copies, not convergence.

For two-way-capable reconciliation, a pulled file updates its bound original page.
New remote files create draft pages in the connected space, at the root. Remote
paths remain bound independently of local display titles/slugs; remote directories
are not automatically converted to an Octavo hierarchy. Existing page IDs and
hierarchy are preserved. Relative Markdown links to known imported/bound pages are
rewritten to those pages. Non-Markdown attachment transfer is not implemented.
Remote `published` metadata does not grant publication or change access controls.
Normal governed-document rules can return edited published pages to draft.

Separate raw remote and canonical local hashes prevent Markdown normalization
from causing repeat imports or unnecessary pushes. Matching changes refresh the
baseline. Existing legacy baselines are read conservatively; reconnecting to a
different repository, branch or path clears old attribution.

## Data protection and unresolved changes

Both-sided changes, missing files/pages, and moves remain explicit unresolved
changes. No page or remote file is deleted. New unbound paths are held when missing
bindings could represent a move, so a rename is not silently duplicated.

Markdown is not a lossless editor representation. Before replacing a bound page,
Octavo checks its semantic JSON round trip; editor metadata that cannot survive
Markdown causes a conflict. Pages with block-anchored comments, highlights or runs
also require review. This conservative rule can hold ordinary-looking editor pages
with additional properties. Unchanged uniquely matching blocks retain their IDs.
In-place pulls are also held whenever collaboration is enabled (the default),
or a persisted `collab_docs` row/seed claim exists. Updating page JSON alone would
leave the Yjs editor state stale and risk a later stale overwrite. No shared state
is deleted or automatically reseeded. Noncollaborative pages without shared state
can reconcile. An experimental epoch-aware path is described below; it is not
enabled by default or approved for production use.
This guard is rechecked inside the write transaction, including late seed claims.
An exact full pre-pull page record is stored transactionally in
`repo_sync_revisions`, independent of normal history's ten-minute throttle. These
recovery records currently have no automated pruning or dedicated restore UI;
retain normal database backups and have an administrator inspect the record before
any manual restoration. Deleting the original page cascades its recovery records.

All remote files are staged before local writes. Full page records, connection and
baselines are rechecked inside the SQLite transaction. A failed local operation
rolls back all pulled pages and checkpoints. Remote Git commits and SQLite cannot
share a transaction: if a remote commit succeeds but local application then fails,
the returned result includes that commit and explicitly reports incomplete local
application. Retry reassesses; manual conflict resolution may still be required.

## Upgrade and downgrade

The additive repository tables, `page_edit_versions`, `collab_room_leases`, and
`collab_recovery_updates` do not rewrite old content. Revision rows are backfilled
and database triggers increment the revision for content/metadata changes.
**API compatibility change:** page PATCH now requires `expectedRevision` (428 when
missing), rejects stale revisions/epochs with 409, and returns the new version.
External PATCH clients must implement conflict recovery before upgrading.
Collaborative WebSocket clients must supply their authorized epoch. Back up before upgrading. Older application
versions do not understand dual baselines or the new safety controls: do not run
repository sync on a downgraded instance. Reconnect and inspect differences before
resuming a different implementation. Read replicas must receive an upgraded
primary's schema before opening this feature.

## Validation

`npm run test:repo` includes provider API-stub checks and actual repository
orchestration with synthetic SQLite. Cases include repeated pulls, original-page
identity/hierarchy, canonicalization, equal-change baseline advancement, concurrent
changes, transaction rollback, failed pushes/reads, explicit deletion/move holds,
legacy state, rich editor data, anchored comments, exact recovery records,
relative links and unchanged block IDs. A combined test exercises the real GitHub
HTTP adapter against a local HTTP fixture plus the real SQLite/data model.

## Staged editor and epoch protections

The editor serializes saves and sends the page revision/epoch observed at load.
A rejected stale save pauses autosave and retains the full draft for download;
it never retries blindly with the new revision. Drafts are stored per account,
page and tab in browser local storage. They persist on that device until explicitly
discarded; shared-device users should remove them after recovery. This is draft
recovery, not automatic three-way merging. Concurrent title edits can still conflict and require explicit recovery; shared
body saves use ordered durability barriers rather than whole-body revision CAS.

`OCTAVO_REPO_COLLAB_SYNC=experimental` enables a bounded test path for plain,
default-schema documents. It checks that persisted Yjs content equals page JSON,
that no active editor lease exists, and that normal Markdown/anchor guards pass.
Then one SQLite transaction records the prior page and Yjs state, applies the page,
materializes replacement Yjs, advances the epoch and updates checkpoints. A failure
rolls everything back. Active rooms, pending seeds and unprojected edits are held.

The collaboration server checks the epoch and lease before accepting updates or
persisting a cached room; old clients receive a stale-document signal and must
recover drafts rather than merge old operations into a replacement document.
Dirty fenced state is archived in `collab_recovery_updates`; failed archival keeps
the document quarantined in memory and retries. Recovery archives have no automatic
pruning or user-facing restore UI. An administrator must review them, and normal
backup/access controls apply. A forced process termination before persistence can
still lose unacknowledged edits: there is no durable per-update acknowledgment
protocol. Old server processes must be stopped before enabling the new protocol.

`npm run test:editor-revisions` covers actual API/SQLite revision conflicts and a
deterministic editor queue harness. `npm run test:collab-epochs` covers cached and
persisted state fencing, restart, leases, archival retry and rollback. Repository
tests cover experimental atomic replacement, repeated pull, late lease acquisition,
and preservation of unprojected shared edits. These checks do not prove complete
end-user offline collaboration. Keep the experimental switch off outside isolated
test deployments until browser, deployment and independent review gates pass.

Server-owned body projection and ordered durable WebSocket barriers are now the
candidate's default collaboration protocol. Clients save shared body edits only
through Yjs and wait for commit acknowledgment; titles use an independent
title/epoch comparison. This avoids competing whole-body REST snapshots. The
complete custom-block schema is shared with the browser, and the server persists
Yjs plus page content/history/search changes in one guarded transaction.

`OCTAVO_COLLAB=0` or `OCTAVO_COLLAB_PERSISTENCE=0` disables collaboration entirely.
There is no legacy attached-server fallback. The persistence flag accepts unset,
empty, `1`, and the older `experimental` spelling as enabled; other values reject
startup. Read `COLLABORATIVE-PERSISTENCE-PLAN.md` for the release gates.

### Migration and disabling collaboration

Back up the database, stop old application processes, deploy the complete server
and schema together, and refresh existing browser tabs. Do not run mixed old/new
collaboration servers against the same database. Use the supplied server wrapper;
it creates the private process capability required for commit requests. Starting
Next directly does not provide a working collaboration server. The documented
`npm run dev` and `npm start` commands therefore explicitly select safe single-writer
mode; they do not advertise or seed barrier sessions. Unwrapped coordinator requests
without the process capability fail closed.

Existing persisted shared documents must project to the same content as their
page before admission. Differences are held for recovery review, not silently
resolved. Unsupported legacy schema forms also fail closed. Empty abandoned seed
markers can be initialized from the page when no active editor lease exists.
Turning collaboration off permits conditional noncollaborative page editing; if
that leaves retained Yjs state different from the page, turning it back on holds
the document for review. Do not delete shared state to bypass this check.

Permission is rechecked before incoming frames merge/broadcast, and every pending
contributor is checked before commit. Already-admitted silent readers are not
instantly evicted on permission changes; complete live read-session revocation is
not implemented. Ambiguous commit responses retry the exact immutable snapshot
rather than silently advancing the baseline.

`npm run test:collab-projection` includes headless schema, actual commit API/SQLite,
server barriers, client provider tests and two-real-WebSocket-client integration.
The latter verifies A/B edits, A leaving while B continues, deletion-only durability,
delayed acknowledgments, independent title changes and server restart. Separate
isolated MacBook Chrome tests verify two distinct users, continued editing after
one leaves, persisted reopening, real epoch-fence recovery, stale-save recovery,
draft download, and retained drafts at a renamed page's canonical URL. The final
four collaboration and six recovery checks passed with zero runtime exceptions.
These used synthetic data, not production content or production load.
An unpublished page rename still leaves other tabs on an old URL that returns
404; reopening the canonical URL exposes the retained draft. Automatic stale-URL
redirection is not implemented.

These tests do not use live repository credentials, prove every provider's deployed
behavior, or establish disconnected-site convergence, exhaustive browser coverage or load
capacity. Existing snapshot replication remains one writer with read-only followers.
