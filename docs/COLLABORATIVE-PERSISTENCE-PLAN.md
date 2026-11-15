# Collaborative persistence: implementation gates

Status: isolated candidate implementation, not a published release guarantee.
Coordinated persistence is now the default whenever collaboration is enabled.
`OCTAVO_COLLAB=0` or `OCTAVO_COLLAB_PERSISTENCE=0` disables collaboration entirely;
there is no attached legacy persistence fallback. Unset/empty/`1` and the legacy
`experimental` alias enable persistence. Other persistence values reject startup.
Default-mode independent review and MacBook browser reruns are required.

The implementation uses a process-random internal commit capability, never sent
to browsers. Projection commits require the live owner, epoch, prior persisted
Yjs hash and prior page-body hash, and call savePage in the same transaction as
Yjs persistence. Title-only saves compare the acknowledged title and epoch rather
than a revision advanced by independent body edits. Initial shared/page divergence
is held for recovery instead of silently picking a winner.

Legacy table cells represented as raw inline arrays currently fail lossless seed
validation; modern tableCell forms are supported. This conservative hold needs
an explicit migration before claiming complete legacy-document compatibility.

## Invariants

1. One active room coordinator owns a page. A second process cannot independently
   replace the persisted document; expired owners are fenced before accepting or
   persisting updates.
2. Shared body content has one authoritative writer. Browser content snapshots
   must not compete through REST with Yjs persistence. Metadata uses independent
   conditional writes; body acknowledgments never rebase pending title edits.
3. Page JSON and Yjs state commit atomically with the same epoch and projection
   generation. Preserve history, search, backlinks, upload references, governance,
   and authorship through the existing savePage semantics.
4. A browser shows Saved only after durable commit acknowledgment covering that
   browser's pending edits. Handshake completion is not persistence. Yjs state
   vectors alone are insufficient because deletion-only updates can retain clocks.
5. Projection failures, lost ownership, changed epochs and unexpected out-of-band
   page-body changes retain recoverable edits and never overwrite a new source.

## Stages

### A. Ownership and recovery

Enforce one live owner per page, including idle cached-room admission. Retain
fenced dirty documents until an additive recovery archive commits. Reject corrupt
persisted documents without reseeding or overwriting the original bytes.

### B. Complete server-side projection

Extract a headless schema equivalent to customBlocks.tsx, including every custom
block and style. Do not use the default BlockNote schema for arbitrary Octavo
pages. Verify custom properties, nesting and IDs, tables, attachments and styles
against real browser output. Runtime-test the module format, not only TypeScript.

Capture an immutable update snapshot, epoch, room generation and covered save
barriers. Project outside the SQLite transaction when asynchronous work is needed.
Inside one immediate transaction verify ownership, epoch, prior committed state
and prior projected body; persist Yjs, call savePage, and record projection
metadata. Newer updates arriving during projection remain dirty and unacknowledged.

### C. Durable ordered barriers

Add a versioned client barrier after its update frames, with connection generation
and request ID. The server captures barriers with the snapshot and acknowledges
only after its transaction commits. Clear recovery only when the local edit counter
has not advanced after that barrier. Reconnect resynchronizes and sends a new
barrier. No fallback to whole-body REST saves during websocket outage.

Use separate title metadata token and body projection generation. Independent body
commits preserve current title; simultaneous title edits conflict explicitly.
Server-owned seeding must materialize page content atomically before admission;
an abandoned zero-byte browser seed claim must never blank a nonempty page.

### D. Release gates

- Two real browsers edit concurrently; A closes and B continues without false
  autosave conflict, then reload and server restart preserve both edits.
- Deletion-only update, edits during projection, and delayed persistence never
  receive premature success acknowledgments.
- Transaction failure and epoch change preserve page/Yjs/recovery state.
- Crash after commit but before acknowledgment safely resynchronizes.
- Disconnect before persistence leaves a downloadable client draft.
- Competing server owners cannot write independently; takeover fences old owner.
- Every custom schema element round-trips losslessly.
- Metadata/body saves do not incorrectly conflict or silently rebase each other.
- Active-session REST body replacement is rejected or explicitly epoch-coordinated.
- Search, backlinks, references, governance and history reflect committed content.

These gates do not establish independently edited disconnected-site exchange.
That requires a separate identity, conflict and durable replication protocol.
