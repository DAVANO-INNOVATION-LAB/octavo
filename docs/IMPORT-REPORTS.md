# Trustworthy import reports

New file, URL and OpenAPI imports save a completion report with their content.
Find **Import report** on the destination space or in its settings. The report
page and JSON download require current read access and space-administrator
permission. Being the original importer does not retain access after revocation.
Reports are not available through public or visitor access.

## What a report means

The report counts actual stored pages, published pages, drafts, published pages
present in the local search index and saved upload records at completion. Preview
page and attachment-entry counts are shown separately as estimates. Folder pages
can increase actual page counts; notebook output images can increase saved files.
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
  can remain. See [Markdown asset handling](MARKDOWN-ASSETS.md) for limits and scope.
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

## Verification

The source and compiled HTTP suites use isolated synthetic imports, sessions,
tenants and SQLite databases. They cover actual count/estimate differences,
success and rollback, postcommit errors, snapshot preservation, access changes,
historical absence and JSON export. Browser QA covers desktop/mobile presentation
of both clean and warning-bearing reports. This does not certify conversion
fidelity for every document or external format.
