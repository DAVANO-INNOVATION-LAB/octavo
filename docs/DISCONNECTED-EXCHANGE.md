# Disconnected site exchange (unpublished candidate)

This is a separate protocol from repository synchronization and read-only snapshot replicas. Each site remains independently writable. Administrators bind one private local space to a shared lineage, verify public-key fingerprints separately, and explicitly trust each origin for that lineage. Private signing keys never travel in bundles or become another site's identity.

## Revision model

Each document has a stable identity and a signed, content-addressed revision graph. Local saved changes are captured before import and export. Concurrent heads are preserved, never selected by timestamp or arrival order. Resolution requires the exact current head set; stale decisions fail. Large decisions create bounded signed intermediate merges in one transaction, retaining the chosen body and all ancestry. Export count/byte overflow rolls the entire decision back.

Forwarded revisions keep their origin signatures. Trust in the forwarding peer does not replace trust in each origin. Revocation blocks future imports and replays, not reading previously accepted content.

This is snapshot-at-exchange, not an every-keystroke journal. Unsaved or divergent collaborative state must be recovered before replacement/deletion. Applied changes update page content and persisted Yjs state transactionally with epoch fencing.

Only title, block content, parent document identity, deletion intent and declared assets travel. Users, credentials, ACLs, tenant membership and publication grants do not. Imported content remains draft. Icons, covers, positioning and arbitrary cross-space moves are not replicated.

## Portable document links

Same-bound-space page links become scoped document-identity references in exchange. Imported links use an access-checked local resolver and follow the target's current slug. Cyclic graphs need no placeholder pages. Draft, publication and tenant policy still apply; missing, deleted, conflicting or unapplied targets do not redirect.

A source-document/path alias ledger preserves previously established identity when an originating target is renamed or archived. Reusing the old path for a different document holds rather than silently retargeting it. Capture does not rewrite a live local editor's content: an original literal URL may still fail locally after rename even though subsequent exchange retains its target identity. Cross-space, ambiguous and unsafe links hold. See [link design](DISCONNECTED-PAGE-LINKS.md).

## Local deletion and recovery

Ordinary deletion of an exchange-managed page uses a read-only confirmation step so its editor can close. Current account/capability, page revision/epoch, space and tenant are rechecked under an immediate transaction. Active editors, divergent Yjs, unresolved revisions, children, unsupported archive state or unexportable history hold removal.

A verified full-object local archive, signed tombstone and removal commit together. Direct deletion cannot bypass this through a subtree or a moved mapped page. Space deletion remains reversible soft-delete and holds exchange while hidden. Incoming deletion intent still requires explicit local acceptance; it never recursively deletes another site's pages.

Archives retain original UUIDs, dependent records and attachment bytes/provenance. Restore is constrained to the original space/tenant and rejects corruption or collisions. Archive children first, restore parents first. Ancillary records stay local; remote restoration does not import another site's comments or permissions. Deletions performed before these protections, or outside the guarded application workflow, are not retroactively recoverable.

## Legacy schema handling

Archival requires reviewed schema semantics, including constraints, indexes and triggers. The explicit reviewed migration can repair three historical missing ownership foreign keys. Default behavior holds on orphans. Opt-in recovery retains their exact records in checksummed, non-cascading local storage before atomic replacement; original missing parents must be recovered before restoring those records.

A disposable 345-page installation copy passed migration and application tests with six orphan states retained and original records preserved. This does not authorize a production upgrade. Migration is operator-only, not automatic startup behavior.

## Security and capacity limits

- Signatures provide integrity/authenticity, not encryption. Use an authorized confidential transfer channel. No document URL is fetched.
- Raw bundles:32MiB; attachments:8MiB each; block content:1MiB per revision; full-history export:5,000 revisions; each revision:100 parents. Large-head resolution accepts at most5,000 expected heads, but new merge nodes must also fit total export bounds. The cap is not a capacity guarantee.
- Incremental/compacted transfer is not implemented. Growing or merged histories can exceed full-export bounds and safely hold operations rather than silently prune records.
- Receipts and revision imports are transactional and replay-safe. Application failures remain visible holds.
- SQLite and files are not one distributed transaction. Failed asset application may leave unreferenced content-addressed bytes; existence alone never grants access.
- No automatic transport, discovery or conflict selection is enabled. An optional secure adapter is assessed in the [transport decision](DISCONNECTED-TRANSPORT-DECISION.md), not implemented or paired with real sites.

## Verification and release

See [validation evidence](DISCONNECTED-EXCHANGE-VALIDATION.md) for source, deployed-browser and copied-installation gates. Synthetic stress tests are not a production-scale performance or all-version compatibility claim. Nothing may be published or deployed without owner review.
