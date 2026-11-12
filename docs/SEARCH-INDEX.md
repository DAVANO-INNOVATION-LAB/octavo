# Import search indexing (v0.27.11)

Published pages are indexed when created, not only when saved later. This fixes
OpenAPI imports whose pages were published but absent from full-text search.
Search matches generated page titles and bodies; an API specification's name is
its space name, not necessarily a generated page title (the landing page is
called `Overview`).

## Behavior

Creation and saving update page records and their search rows in one SQLite
transaction. An index-write failure rolls back the page change, including any
snapshot or related metadata writes. The transactions also participate in import
rollback, so a later import failure leaves no searchable partial import.

Only published pages enter the index. Quality-governed imports remain drafts;
editing a governed published page still returns it to draft as before. Search
also checks current publication explicitly, alongside existing private-space,
tenant and deleted-space filters. Existing ranking and pagination are unchanged.
Direct database writes by external tools are not automatically indexed; supported
application creation/save paths maintain the index.

## Upgrade and one-time recovery

Before upgrading, back up the database and upload volume. On the first writable
startup, Octavo rebuilds the derived full-text index from the stored title and
plain-text body of every published page. It removes missing/stale-index problems,
duplicates, orphaned entries and draft entries. The completion marker commits in
the same transaction as the rebuild. If rebuilding fails, neither replacement
index nor marker commits; fix the underlying storage problem before retrying.

This does not save, publish, edit, delete or rewrite source pages, timestamps,
page versions, memberships, grants or uploaded files. Soft-deleted spaces remain
excluded by the search query; retaining their derived rows supports later restore.
Subsequent startups see the marker and do not rebuild. Read replicas do not run
migrations; upgrade the writable primary and replicate its updated snapshot.

**Large libraries:** the initial rebuild reads all published text, holds a writer
lock, and needs temporary/WAL disk headroom. Schedule that first startup in a
maintenance window and allow it to finish before starting additional workers.
Startup can fail if storage is full or another writer holds the database lock.
This release does not claim zero-downtime migration for large corpora. Do not
remove the completion marker casually: doing so requests another full rebuild.

## Verification

`npm run test:import-search` covers actual upload/URL/OpenAPI handlers, title/body
search, scoped results, governed drafts, rollback, index repair, retry and source
preservation using isolated synthetic SQLite fixtures.
`npm run test:import-search-http` exercises compiled OpenAPI forms, uploads and
search over loopback with real synthetic sessions. No production dataset or
hosted tenant is used; large-library migration timing depends on its content and
storage and is not inferred from these fixtures.
