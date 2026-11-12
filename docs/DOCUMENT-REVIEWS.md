# Document quality

Open **Admin → Document quality**, or **Review & checks** from a page editor.
Editors see only spaces they can edit. Agents and deactivated accounts cannot
use quality mutations. Every mutation checks the current content fingerprint.

| Improvement | Available behavior |
| --- | --- |
| Ownership and reviews | Assign an active editor and UTC due date; verify a revision without rewriting content or edit timestamps. Source edits invalidate reviews of synced content. |
| Links and assets | Check local page destinations, heading/block anchors, synced sources and uploaded files. External URLs are listed as unchecked; the server does not fetch arbitrary URLs. |
| Search | Filter before ranking by space, owner ID (`me` for the current user), collection and update window; highlighted snippets and pagination retain permission scope. |
| Reusable content | Register a published source page, insert it as a synced block and inspect editable usages. Nested synced sources are rejected by this insertion flow. |
| Import preview | Inspect page names/counts, unsupported blocks, duplicate titles and missing references before confirmation. The file digest binds confirmation to its preview; page writes are transactional. |
| Feedback | Assign feedback, move it through open/in progress/resolved, and require a resolution note. |
| Publishing checks | Space administrators can require headings, a current review, independent publisher approval and local link checks. Editing governed published content returns it to draft. |
| Version comparison | Compare saved versions or current content as Markdown, with an optional structural diff for media, diagrams and table properties. History is editor-only. |
| Runbooks | Define expected output, download a revision-bound plan, explicitly execute it locally, and submit evidence. Changed definitions/revisions reject old evidence. |
| Release bundles | Export published-page Markdown and block JSON with attachments, review metadata and SHA-256 checksums. Version label can be supplied as `?version=1.0`. |

Runbook execution:

```sh
# Inspect the downloaded command first; run only in an authorized environment.
node scripts/runbook-check.mjs --execute runbook-plan.json > evidence.json
```

Paste the resulting JSON into the page's execution evidence field. Commands run
on the invoking machine with its permissions, with a 30-second timeout and
bounded output. Octavo never executes them on its web server. Submitted results
are user-provided evidence, not independently attested execution.

Bundles are read-only snapshots, not application backups. They omit drafts,
include accessible published synced sources, and fail on missing local assets.
External URLs/interactive embeds may still need network access. Review metadata
reflects export time. Import previews for Word and notebooks report structural
counts; complex formatting and notebook outputs are converted on confirmation.
ZIP and Word archives are checked before preview or import: local/central headers,
entry boundaries, expanded sizes and CRC32 must agree. Stored and deflated
archives (including streaming data descriptors) are supported; encrypted, split
and ZIP64 archives are not. Limits are 10,000 entries, 100 MB per expanded entry
and 200 MB total expanded data. CRC32 detects accidental corruption; it does not
authenticate the sender.

A failed import rolls back database content; attachment files already written
may remain orphaned and can be handled by the existing upload sweep.

Validation: `npm run test:quality` exercises a disposable SQLite database,
review concurrency and timestamp invariants, permission checks, publishing
rules, runbook evidence, import preview, search filtering and bundle generation.
Existing core and authentication tests remain required. New schema tables are
additive; upgrade the writer before opening a replica with this code.
