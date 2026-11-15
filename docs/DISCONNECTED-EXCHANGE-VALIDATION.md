# Disconnected exchange candidate validation

Unpublished local candidate, verified 2026-11-14 on macOS. Tests used isolated synthetic databases and disposable copies of a prior production-derived upgrade installation. No live installation or original backup was modified. Publication requires owner review.

## Passed gates

- Optimized standalone build and TypeScript check.
- Signed exchange core: 28 cases, including three-site forwarding, replay, tampering, restart, reverse ancestry and cross-lineage asset-cache isolation.
- Application/API integration: 35 groups, including per-space capability ceilings, full-object archival, hierarchy restoration, attachment bytes/provenance, corruption/collision rejection, unsafe-integer preservation and schema guards.
- Pagination/full-revision API: 7 groups, including more than 100 documents, more than 20 revisions, long-content selection, authorization and escaped-request bounds.
- Actual three-site Chrome: 11 groups, zero runtime exceptions. Independent local servers/browser contexts exercised signed file download/upload, offline conflicts, explicit convergence, private attachments, forwarded-origin trust, process restart, reversible archival/restoration and HTTP authorization.
- Actual pagination Chrome stress: 4 groups, zero runtime exceptions, with 105 documents, 28 retained revisions and complete 12–15 KB conflict resolution/restoration.
- Portable document links:21 integration groups and5 actual standalone Chrome groups, including origin aliases, cyclic links, renames, archive/restore, publication and tenant access.
- Guarded ordinary local deletion:15 integration groups; three-site Chrome also verifies stale confirmation refusal and original local UUID/comments restored through a remote roundtrip.
- Large-conflict API:2 groups. Actual Chrome additionally resolves101 visible heads through one complete-content decision and two signed merge nodes. Core stress resolves4950 heads at exactly5000 total revisions and verifies overflow rollback.
- Reviewed legacy migration/recovery: 14 groups, including exact row/column/index/trigger preservation, orphan retention, parent-gated restore, corruption/collision rejection and rollback.
- Authentication regression, editor revision integration (8), save queue (9), and collaboration epoch fencing (45).

## Copied-installation upgrade evidence

The prior upgrade-chain database contained 345 pages and three missing ownership foreign keys. Six collaboration-state rows had no parent page. Default migration refused these orphans without changing rows.

On a separate disposable copy, explicit retained-orphan mode repaired all three foreign keys and kept all six orphan records in a checksummed, non-cascading recovery store. Reconstructing live plus retained records preserved the original row bytes across every table. Integrity and foreign-key checks passed. The migrated schema matched the reviewed archival schema.

The complete 35-group application suite then passed against a migrated copy with synthetic fixtures alongside the original records. All 345 original pages retained their exact SQL values, and the original source database hash remained unchanged.

This is evidence for the specific tested copy and reviewed schema shapes, not every historical version or a live production upgrade. The migration helper is local and explicit, not wired into automatic startup. Recovery has no external API/UI payload exposure. An orphan can be restored only after its original missing parent has been recovered; the migration never invents parents or discards orphan bytes.

## Defects found and corrected

- Browser request origin rejected valid requests because of framework URL normalization; use the existing Host-based same-origin guard.
- Cached attachment bytes crossed unrelated lineages; incoming full-history bundles now carry their own declared bytes.
- Instance-admin checks bypassed direct space-agent ceilings; selected data and mutations now require space administration capability.
- Incoming deletion could cascade ancillary records; explicit acceptance verifies retained full-object archival first.
- Schema guards now preserve SQL semantics, order-sensitive conflict policy and dependencies. Unsafe numeric serialization holds before any removal.
- Lazy SCIM schema initialization diverged from source fixtures; normal database startup now applies the same guarded active-column migration.
- Large document/history collections and truncated revisions were inaccessible through the UI; bounded pagination and authorized complete-revision review now support selection.
- Nested JSON transport rejected valid heavily escaped bundles; encoded transport bounds now accommodate the unchanged raw bundle limit.
- A stale epoch fixture omitted the standalone wrapper's process-local capability; its isolated fixture now supplies one.

## Commands

`npm run build`; `npx tsc --noEmit`; `node scripts/site-exchange-test.mjs`; `node scripts/site-exchange-app-test.mjs`; `node scripts/site-exchange-pagination-test.mjs`; `node scripts/site-exchange-browser-test.mjs`; `node scripts/site-exchange-pagination-browser-test.mjs` (also with `LARGE_HEADS=1`); `node scripts/site-exchange-links-test.mjs`; `node scripts/site-exchange-links-browser-test.mjs`; `node scripts/site-exchange-local-delete-test.mjs`; `node scripts/site-exchange-many-heads-test.mjs`; `node scripts/reviewed-legacy-fk-test.mjs`; `node scripts/auth-test.mjs`; `npm run test:editor-revisions`; `npm run test:collab-epochs`.

The copy-validation harnesses accept an explicitly selected local backup; they never migrate the original source. Actual production migration remains a separately reviewed operator action.

## Remaining boundaries

This is snapshot-at-exchange, not an every-keystroke journal or background transport. Bundles are signed, not encrypted. Cross-space or ambiguous document links and oversized full-history bundles remain held. Imported identity links follow current slugs. Ordinary reader links with previously captured source aliases now resolve through stable identities without mutating stored content or active editors; uncaptured links, editor/raw URLs and specialized surfaces remain unchanged. Visitor-token-only access to private spaces remains fail-closed in the resolver. No automatic conflict merge or production-scale performance claim is made. Large conflict resolution remains bounded by total export bytes and revision count; its5000-input-head limit is not a promise that a graph at the storage boundary can add merge nodes. Incremental transfer/history compaction remains unfinished.

Archival is explicit, leaf-first, local to the original space/tenant, and restores parent-first. It protects incoming deletion acceptance and new ordinary deletions through the guarded exchange-managed workflow. It cannot reconstruct records removed before those protections or by direct out-of-band database operations. Ancillary records remain local rather than being replicated as comments, identities or permissions. Unreviewed schemas, missing parents, corruption and identity collisions continue to hold safely.

Automatic transport remains a design proposal, not an enabled service. See [transport assessment](DISCONNECTED-TRANSPORT-DECISION.md) for peer-authentication, sharing, endpoint and operational prerequisites. No actual peer configuration, credentials or remote data transfer was performed.

## Incremental core safety checkpoint (2026-11-14)

The incremental delta prototype is deliberately **core-only**. The application import path explicitly accepts only full snapshots and rejects incremental bundles before capturing local changes or applying remote pages. No incremental API/UI, compaction, scheduled exchange or automatic network transport is enabled.

A receiver-signed, lineage-scoped inventory and recipient-bound delta envelope omit already retained revision records. Import checks the receiver's actual basis, traverses the authenticated source frontier, revalidates omitted origin trust and retained attachment bytes, and holds on rollback, missing/corrupt content or receipt inconsistency. No partial transfer prefix is exported.

New isolated synthetic tests: 10 incremental core cases passed, covering convergence/replay, omitted attachment loss and corruption, receiver rollback, recipient mismatch, inventory tampering, incomplete frontier, revoked origin in a zero-incoming-revision forwarded delta, replay after asset loss, and concurrent local edits. Application integration now passes 36 groups, including the explicit delta gate. Existing core 28, portable links 21, local deletion 15 and pagination 7 passed again. TypeScript, optimized standalone build and diff whitespace check passed on the updated candidate.

Read-only independent review found no concrete integrity/trust/atomicity blocker in this scoped prototype. Its test-fixture correction for omitted-origin revocation was applied and rerun. This is not exhaustive: new inventory/graph limits and histories beyond 5,000 revisions still need focused boundary/stress coverage; incremental application and browser behavior remain unimplemented and unvalidated. Prior browser and copied-installation evidence above belongs to the earlier full-snapshot milestone, not this new incremental proof. Nothing was deployed or published.

## Gated incremental application/UI checkpoint (2026-11-14, subsequent)

This checkpoint supersedes the earlier core-only status above. Manual incremental inventory export, recipient-specific delta export and delta import are implemented through the existing administrator/per-space/same-origin API boundaries. The UI describes the receiver → sender inventory step and sender → receiver delta step. The server gate `OCTAVO_EXCHANGE_DELTA=1` is required; it remains **off by default** and was enabled only inside disposable test servers. No live installation setting was changed.

Receiver inventories are signed, lineage-scoped statements of retained revision IDs, not permission grants. Delta export requires trust in the inventory holder and binds the signed envelope to that receiver. Import rechecks receiver basis, all reachable origin signatures/trust and attachment bytes; captures unsent local edits in the same database transaction before import/application. Concurrent edits become explicit conflicts rather than overwriting the original page. Bundles remain signed but unencrypted and require private manual transport.

Final focused evidence:

- 13 incremental core groups, including a 5,001-revision graph where full snapshot export correctly refuses but a one-revision delta succeeds; inventory count accepts 50,000 and refuses 50,001, and oversized inventory bytes reject before parsing.
- 41 application/API groups, including default-off rejection, original-page incremental application, local-conflict retention, rejected import/export rollback, authenticated inventory access, and a 5,001-revision single-document history advancing the original page through delta.
- 14 actual three-site Chrome groups, zero runtime exceptions, repeated successfully. Tests exercise real UI inventory downloads/file loads, recipient-bound delta download/import, conflict resolution back to the first site, third-site forwarding, verified attachment retrieval and exact replay with stable page IDs.
- TypeScript and optimized standalone build pass. Existing full-snapshot core 28, links 21, deletion 15 and pagination 7 regressions are retained.
- Independent read-only review found no concrete integration blocker in the scoped change. Dedicated screenshots capture the experimental incremental controls.

Limitations remain: no background transport, compaction, every-edit journal, automatic merge, real external peer transfer or production migration. Full snapshot export and conflict-resolution mutation guards still enforce their original 5,000-revision/32 MiB bounds; delta support does not imply that large-history resolution is unbounded. The 128 MiB graph byte limit and combined extreme-size/50,000-revision signature workloads have not received exhaustive stress testing. The new large-history evidence is synthetic, not a rerun on the 345-page production-derived copy. Publication and deployment remain held for owner review.
