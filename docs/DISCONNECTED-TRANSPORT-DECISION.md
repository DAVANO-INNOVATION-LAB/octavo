# Disconnected exchange transport decision

Status: deployment design plus a disabled, unconnected loopback staging prototype. No application network service is enabled.

## Decision

Keep signed manual bundle exchange as the default. Finish identity-safe links, guarded local deletion and bounded large-conflict resolution before adding automatic delivery. The existing database snapshot replica is not an independently writable-site transport: it transfers a whole library under a single-writer model and must not be reused as the exchange protocol.

For an optional adapter, prefer explicit peer-to-peer HTTPS over a generic arbitrary-URL fetcher or shared snapshot bucket. Use TLS with authenticated peers for confidentiality in transit; keep origin signatures and lineage-specific trust independently enforced. TLS supports server authentication and optional client authentication; the proposed adapter would require both. This is a design choice, not a certification claim. [TLS1.3 specification](https://www.rfc-editor.org/info/rfc9846/).

## Required boundaries

- Separate machine principal per paired peer, restricted to approved lineages and import/export. No account-wide administrator cookie, trust modification, archival, conflict resolution or permission replication.
- Explicit endpoint, port and certificate/CA enrollment; no discovery, URL supplied by bundle content, redirects or silent trust-on-first-use.
- Destination allowlist and resolved-address enforcement with hostname/certificate checks retained. Private cluster addresses require explicit allowlisting, not a blanket internal-network exception. Restrict outbound network access as defense in depth. [OWASP SSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).
- Stream raw bounded bundles, verify signatures/assets before application, retain idempotent receipts and atomic imports. Authenticated transport must not bypass untrusted forwarded-origin checks.
- Durable bounded retry queue, exponential backoff, cancellation, connection/offline status and restart recovery. No automatic conflict selection, deletion acceptance or regranting revoked trust.
- Default incoming staging/review; automatic nonconflicting application is a distinct, explicit per-lineage setting. Record metadata-only audit events without document bodies or credentials.
- Keys remain local and private, distinct from document-signing keys, with rotation/revocation procedure. TLS does not encrypt stored queue files; require protected local storage or separately reviewed envelope encryption.

## What blocks enabling it

No actual peer endpoint, network boundary, certificate ownership, machine identity, lineage-specific sharing approval or retention policy has been supplied. No remote peer has been contacted, credentials created, network permission expanded or document transmitted for this proposal.

These missing deployment details do not block developing and testing a disabled adapter against synthetic loopback peers, but do block pairing it with real sites. Manual exchange is still required for fully disconnected environments.

## Acceptance gates before deployment

Loopback mutually authenticated peers; expired/wrong/revoked certificates; wrong lineage/origin; redirects and DNS-rebinding escape; duplicate/reordered/interrupted delivery; disk-full/restart; oversized/compressed payloads; missing or corrupt assets; bounded backoff; credential redaction; staged import and explicit conflict/deletion review. Run separately from snapshot replica tests. Enable only after owner review of exact peers and sharing scope.

## Disabled loopback staging prototype (2026-11-14)

A separate, unconnected transport primitive now exists in `src/lib/site-exchange-transport.ts`. It is not imported by the application, does not start a server, and requires explicit enablement and enrollment supplied by the caller. This prototype only permits enrolled loopback addresses (`127.0.0.1` or `::1`); it is deliberately unsuitable for real peer deployment.

One-shot delivery uses TLS 1.3, CA and hostname verification, exact server/client certificate digests, an enrolled lineage/path and explicit mutual TLS credentials. Hostname lookup is replaced with the enrolled literal loopback address; numeric endpoint addresses must match it. No redirects, cookies, ambient proxy, compressed messages, automatic retries or arbitrary destinations are accepted. Both request and response bytes and elapsed time are bounded. Errors omit document bodies and credentials.

The receiver requires a verifier callback to validate the complete signed bundle and attachments without applying pages, followed by a staging callback. Tests use the real exchange engine inside a rollback transaction and a synthetic digest-keyed staging map. **The primitive does not provide durable storage, a queue, restart recovery, retention quotas, retry/backoff scheduling, audit integration or an application staging-review UI.** A real staging callback must implement private durable, digest-idempotent retention. A timeout cannot cancel a callback already persisting data: delivery may be staged without an acknowledgment; operators must treat that outcome as ambiguous and retry idempotently, not as confirmed cancellation.

No real endpoint, user data, production database or credentials were used. Pairing real sites, enabling remote addresses and building operational queue/review controls remain separately reviewable work. Certificate expiry/CRL lifecycle, rotation and mid-flight revocation workflows are not implemented by this primitive.

Validation: 18 synthetic loopback security groups passed twice, including missing/wrong client identity, wrong server pin/hostname, non-loopback/numeric-address mismatch, receiver TLS 1.2 refusal, signed corrupt attachments, wrong scope, redirect/compression/size rejection, interrupted/timeout/mismatched receipts and simulated staging failure. TypeScript and whitespace checks pass. Independent source review identified and corrected numeric-address lookup bypass and receiver TLS-version enforcement before this checkpoint. No actual external endpoint was contacted.

## Bounded durable inbox prototype (2026-11-15)

`src/lib/site-exchange-staging.ts` adds a separate opt-in SQLite inbox primitive, tested through the synthetic loopback transport. It is still **not connected to the application or any running service**. The caller supplies a dedicated privately protected local database and a verifier enforcing current lineage/origin trust, signatures and attachments. The inbox copies and checks digests/scope, verifies even duplicate admissions, commits before acknowledgment, bounds retained item count and logical payload bytes, and returns metadata-only listings. Review reads revalidate current trust. No page import, automatic conflict/deletion decision or permission transfer occurs.

Admission rejects nested caller transactions, non-disk journal modes and reduced synchronous settings. The inbox requires synchronous FULL and a disk-backed DELETE/TRUNCATE/PERSIST/WAL journal. SQLite storage and filesystem correctness remain deployment assumptions; the logical quota is not a bound on database/WAL file size. Payloads are not encrypted at rest by this class. Database directory permissions, encryption and maintenance remain deployment obligations.

Fresh validation on the Mac: 17 synthetic durable-inbox groups, 19 loopback transport groups, 28 core exchange cases, 13 incremental cases, TypeScript and whitespace checks pass. Tests include close/reopen, duplicate delivery, current-trust rejection, bounded quotas including cumulative bytes and two database connections, caller-buffer mutation, disable-during-validation, simulated storage failure, corrupt stored bytes, unsafe journal modes and outer-transaction rejection. A disposable child process was killed after successful admission and the bundle recovered on reopen. This proves that test's abrupt process-exit recovery, **not power-loss, actual full-disk/filesystem-fault or multi-host durability**. Independent review found the outer-transaction and journal-mode gaps; both were fixed with regressions before this checkpoint.

Still missing: outbound durable retry/backoff queue, scheduling/cancellation, application integration, user-facing staging-review UI, complete inbox pagination, retention/eviction policy, metadata-only audit integration, certificate lifecycle, real-peer deployment and production validation. The inbox does not automatically delete pending bundles to free quota. Filling it fails closed and requires a future reviewed retention workflow. No service is enabled and no real document or credential is transmitted.

## Bounded durable outbox prototype (2026-11-15)

`src/lib/site-exchange-outbox.ts` adds an opt-in SQLite delivery queue that a caller explicitly advances with `tick()`. There is **no scheduler, application endpoint or running service**. It uses the existing loopback-only transport and has been integrated with the durable inbox only in synthetic tests. Pending records retain the exact bundle digest and an enrollment fingerprint over the peer endpoint, literal address, server certificate pin, lineage, CA and client certificate. Private keys, resolved credentials, response/error bodies and endpoints are not included in queue metadata. Payload bytes remain plaintext in the protected local SQLite database; no at-rest encryption is claimed.

Each attempt rechecks signed content/current trust and enrollment, and a changed enrollment holds the item rather than silently sending it to a new target. This is point-in-time preflight validation, not instantaneous mid-flight revocation. Credential buffers are copied for dispatch. Async preflight has a configurable maximum 30-second logical deadline; timed-out callbacks may continue and must remain side-effect-free, with no independent transmission or page application. A timer cannot interrupt synchronous event-loop blocking.

The queue bounds logical items/bytes and attempts (at most eight), uses capped exponential backoff after failed acknowledgment, and preserves pending/held/staged/cancelled states across reopen. A 60-second lease plus opaque ownership token prevents competing workers from completing the same active claim. Expired leases become retryable or held on a later explicit tick. Retrying ambiguous delivery is at-least-once; the inbox's digest idempotence prevents duplicate staged records, not an unsupported exactly-once network claim. A successful `staged` state means a verified staging receipt, never page import/application.

Cancellation stops future attempts only. If a request may already have reached a peer, the retained outcome is `unknown`, even if a late receipt follows cancellation. Disabled-before-send returns the record to pending without consuming a network attempt. Reduced retry limits after reopen hold already-exhausted work. Retained terminal records count against quotas; no automatic deletion, eviction or retry reset exists.

Validation: 36 synthetic loopback transport/queue groups (19 existing transport/inbox groups plus 17 queue groups), 17 durable inbox groups, 28 core exchange cases, 13 incremental cases, TypeScript and whitespace checks passed. Queue cases cover reopen/idempotence, bounded exponential retries, cancellation before/during verification and network staging, changed enrollment/revoked trust, quotas including retained terminal bytes, competing database connections, expired leases/stale workers, corruption/nested transactions, hung preflight, disabled dispatch and reduced retry limits. A lost-receipt case delivered through mTLS into a durable inbox, reopened that inbox, retried the same bundle and retained exactly one staged record without applying any page. Independent final source review found no remaining blocker for this restricted prototype.

Still missing before real deployment: application adapter and authorization/generation fencing, user-facing inbox/outbox review controls, inbox pagination, retention/removal workflow, scheduler lifecycle and operational status, certificate rotation/revocation, metadata-only audit integration, actual full-disk/filesystem/power-loss testing, real-peer enrollment and production validation. No live data was changed, no real peer contacted and no service enabled.

## Opt-in manual staging review in the app (2026-11-15)

With `OCTAVO_EXCHANGE_STAGING=1` only, `/admin/exchange` now exposes a manual staging-review panel. The default remains disabled. This closes the earlier manual review/pagination gap; it does **not** connect the network transport or outbox to the application, expose a peer endpoint, start a scheduler or enable automatic imports.

Authenticated instance administrators must also have administration rights on the selected space. POSTs require same-origin requests; responses use no-store. Manual upload verifies signed content, current trust and selected lineage against current local state inside an always-rolled-back app transaction, then retains bytes in a separate private inbox. Staging and preview do not project pages or retain local capture changes. The private inbox directory and database reject symlinks and permissive group/other permissions; retained bytes are not encrypted at rest.

The panel pages through retained metadata, displays the exact SHA-256 and a bounded current-state preview (at most 100 documents and 10 heads per document), and can download the exact signed bundle for complete content review. An unchecked confirmation prevents import. Selecting another bundle, uploading, refreshing or changing space clears the old review/confirmation. A generation guard prevents delayed initial-list responses from overriding newer refreshes. The application does not claim that a human actually read a downloaded file; confirmation is the administrator's explicit request.

Explicit reviewed import revalidates and uses the existing original-space reconciliation path. Local edits made after preview remain protected as conflicts; deletion intentions remain held for the existing separate reversible-archival decision. A retained inbox record is not an application receipt. Import/replay does not delete that record; no retention/removal policy has been implemented. Incremental bundles remain separately gated by `OCTAVO_EXCHANGE_DELTA=1`.

Validation on isolated synthetic data: 49 application integration groups, 18 real three-site Chrome groups with zero runtime exceptions, 36 transport/outbox groups, 17 inbox groups, production build, TypeScript and whitespace checks pass. Coverage includes staging without page/revision mutation, exact downloaded bytes, current-trust revocation, wrong-lineage isolation, disabled staging/delta, storage permissions, 51-bundle pagination, administrator and selected-space access, explicit confirmation, safe replay, post-preview local edits, staged deletion holds, confirmation reset, space switching and deliberately reordered initial-list/refresh responses. Independent source review found no remaining blocker for this opt-in manual adapter.

No real peer was enrolled, no live installation or data changed and no release published. Remaining deployment work includes network/outbox integration with scoped machine principals and generation fencing, operational scheduler controls, retained-item disposition/removal, metadata-only audit integration, certificate lifecycle, real-peer authorization and fault/production validation. Existing application-wide immediate manual import remains available; staging is an optional workflow, not a mandatory import policy.
