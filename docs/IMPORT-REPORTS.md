# Trustworthy import reports

New file, URL and OpenAPI imports save a completion report with their content.
Find **Import report** on the destination space or in its settings. The report
page and JSON download require current read access and space-administrator
permission. Being the original importer does not retain access after revocation.
Reports are not available through public or visitor access.

## What a report means

The report counts actual stored pages, published pages, drafts, published pages
present in the local search index and saved upload records at completion. Preview
page and attachment-entry counts are shown separately as estimates. Before
confirmation, Markdown/Notion ZIP previews also show an optional referenced-asset
copy plan: distinct files and their total bytes. This is different from the
archive attachment-entry estimate, and preview writes no files. Human-readable
sizes include exact byte counts. When no plan is returned, the UI says it is
unavailable rather than displaying zero.

Markdown/Notion ZIP previews now share a destination planner with the importer,
showing planned titles, hierarchy, publication states and generated folder pages.
Those generated folders are included in the planned page list rather than appearing
only as a surprise after import. This is a read-only plan, not already-created
content or guaranteed conversion fidelity. Other formats can still have differences
between preview estimates and completed results; notebook output images, for
example, can increase actual saved-file counts.
Search indexing does not mean the content is public.

Warnings from preview are retained, alongside page-count differences and remaining
relative references detected after conversion. Conversion notes identify known
limitations. "Import completed" means the transaction committed, not that every
source item was preserved. No warnings is not a fidelity guarantee. Review important
pages, links, formatting and attachments before relying on an import.

Known examples:
- Markdown/Notion ZIP imports can create draft folder pages. Supported assets
  referenced by parsed content are copied and deduplicated by resolved archive
  entry; unreferenced bundle files are not copied. Missing or unsupported references
  can remain. Recognized relative `.md` links to imported pages are resolved in a
  second pass to the pages' actual assigned slugs, including forward links and
  duplicate-title cases. Preserved query strings or fragments do not guarantee
  matching rendered heading anchors. New imports select one primary index
  document per folder deterministically, preferring `index.md` over `README.md`;
  competing documents are retained as separate child pages with distinct links,
  including at the import root. Actual page counts can therefore differ from
  older imports that overwrote competing folder documents. Existing imports and
  previously overwritten content are not reconstructed. See
  [Markdown assets and page links](MARKDOWN-ASSETS.md) for limits and scope.
- Notebook raw cells and unsupported rich outputs are omitted.
- Word formatting, embedded objects and media may not be fully preserved.
- URL imports convert readable text; linked media is not archived.
- OpenAPI imports generate documentation, not a lossless specification round trip.

## Persistence, access and export

Reports and imported content commit together. A report-write error rolls back the
import, including files created by that attempt. This handles exceptions, not
crash-atomic coordination between the database and filesystem. A cache-refresh
or audit-forward error after commit does not erase the report or invite a duplicate import.
Existing success redirect paths and URL response fields are unchanged.

A report is a **snapshot at completion**, not a current space inventory. Later
edits, publication changes and file changes do not rewrite its totals. Reports
for imports performed before report recording was introduced are not reconstructed.
The report page shows an explicit no-report state for those spaces.

The report stores a source filename basename, source hostname for URL imports, or
a fixed OpenAPI label. It does not add source document contents or full URL query
strings to the receipt. Warnings may describe private document titles or paths,
which is why current read/admin authorization applies to both HTML and JSON.
JSON downloads use private, no-store caching. Soft-deleted spaces are inaccessible;
hard deletion of a space also removes its receipt.

## Recent import history

Open **Recent imports** from the Import screen to find saved completion reports,
newest first. The list includes only destination spaces you can currently read
and administer, not every import on the instance and not necessarily only imports
you performed. A past importer has no permanent right to see a report.

Cards show the source method and label, completion time in UTC, actual saved page
and attachment counts, and the number of recorded warnings. These are completion
snapshots, not current space totals or fidelity guarantees. Each card links to the
full report and destination space. Historical imports without saved reports are
not reconstructed.

Older/Newer navigation shows up to 20 accessible reports per page. Pagination is
based on accessible reports; the screen does not display totals for unavailable
spaces. Changes in access or new imports can change the list between visits.
An empty page does not mean the instance has never imported anything.

## Verification

The source and compiled HTTP suites use isolated synthetic imports, sessions,
tenants and SQLite databases. They cover actual count/estimate differences,
success and rollback, postcommit errors, snapshot preservation, access changes,
historical absence and JSON export. Browser QA covers desktop/mobile presentation
of both clean and warning-bearing reports. This does not certify conversion
fidelity for every document or external format.

History navigation shows up to the newest 20,000 currently accessible reports
(1,000 pages). Individual saved reports remain available from their destination
space beyond this navigation window. New imports or access changes between page
requests can shift offset-based page contents.

## Upload provenance snapshots

New file-upload receipts record a SHA-256 fingerprint and byte length of the submitted upload, the receipt ID as an import-scoped source identity, the Octavo converter version, and capture time. Their provenance manifest links the source to each stored page's content hash and each newly attributed attachment's stored byte hash. The existing administrator-only JSON download includes the manifest; space readers and unrelated users do not gain access to receipts or hashes.

These are **completion snapshots**, not live integrity checks. Later edits, attachment changes and removals do not rewrite the captured hashes. Page hashes cover stored content, not the title or every page metadata field. Importing identical bytes again produces the same content fingerprint but a separate import identity. No global fingerprint lookup or cross-space deduplication is performed.

The manifest describes derivation from the whole uploaded file. It does not claim an exact original archive-entry mapping for each converted page, conversion fidelity, authorship, publisher authenticity or a cryptographic signature. The original uploaded archive/document is not retained by this feature. A hash cannot reconstruct it. Keep an authorized original separately if you need later comparison. Failed conversions do not retain originals or create a successful receipt.

Older receipts, URL imports and OpenAPI imports show provenance as not recorded. Historical identities are not reconstructed from current content. The manifest is saved in the import transaction; capture failure rolls back the import rather than returning partial provenance. No schema migration is needed: existing receipt JSON remains readable. Reverting the application release leaves receipt JSON in place but older code will not display the new field.

Capture is bounded to 10,000 combined pages and attachments and 512 MiB of saved attachment bytes per import, in addition to the existing upload-size limit. Imports exceeding these limits fail and roll back rather than omitting manifest entries. Hashes do not grant file access and are not a cross-tenant matching service.

## Check recorded outputs

Space administrators can explicitly **Check recorded outputs** from a receipt that has upload provenance. The check compares each recorded page's current stored content and each recorded attachment's current bytes with the import-time hashes. It does not edit content, replace the receipt, or run automatically on page load. Results can be downloaded as a dated JSON snapshot.

- **Unchanged**: the checked content bytes match the recorded hash.
- **Changed**: the bytes differ. Normal edits can cause this; it is not a corruption or security-incident diagnosis.
- **Missing**: the recorded output is no longer available in the same space. Moved outputs are not followed into another space.
- **Unavailable**: a baseline, file, permission-independent resource limit or safe read prevented comparison. This is never counted as unchanged.

The check covers recorded outputs only. New pages and files added after import are not included. Page titles, permissions, publication state and other metadata are outside the page-content hash. Original uploaded source bytes were not retained, so the source itself is explicitly **not checked**. Results are a point-in-time observation, not ongoing monitoring, a signature, provenance authenticity or proof of lossless conversion.

The POST endpoint is `/api/spaces/<slug>/import-report/verify`. It requires current receipt access and a same-origin request with the original Host preserved by reverse proxies. Responses are private and not cached. No successful comparison is inferred for legacy or malformed receipts. Permission revocation takes effect on the next check; previously downloaded results remain the recipient's copy.

Verification reads at most 64 MiB of combined current page content and attachment bytes across at most 10,000 recorded outputs; stored receipts larger than 8 MiB are unavailable. Items beyond the read budget are marked unavailable, never skipped as passing. This lower verification budget is separate from the import capture limit.
