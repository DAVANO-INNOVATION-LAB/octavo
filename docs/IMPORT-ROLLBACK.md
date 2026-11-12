# Import rollback

This release covers `/api/import` upload confirmation and `/api/import/url`.
OpenAPI and benchmark server actions and repository synchronization are separate
flows and are not covered by this transaction boundary.

Upload confirmation runs content creation, publication and importer ownership in
one outermost immediate SQLite transaction. URL import fetches and converts the
document first, then commits space, membership, page, publication and the local
audit entry together. URL audit forwarding happens only after that commit; a
collector failure does not undo committed content. URL network safeguards remain
unchanged. Preview remains read-only and does not create attachments.

XML/HTML Confluence and notebook image writes share a per-operation ownership
ledger. Each upload is opened exclusively, never overwritten, and its identity
is recorded before writing its bytes. A write, close, database mutation or commit
failure rolls back the database and removes that attempt's own files. Filename
collisions leave the existing file intact. Cleanup checks file identity and never
scans the uploads directory. This protects unrelated files during ordinary
exception recovery, not against concurrent filesystem replacement races. Direct
library parser calls outside the transaction receive exclusive-write/partial-write
protection only; callers requiring full rollback must use runImportTransaction.
The helper is synchronous and must be the outermost transaction. Declared async
functions are rejected before invocation; returned thenables are rejected too.
Callbacks must not schedule later work: arbitrary asynchronous side effects
cannot be cancelled or included in a synchronous SQLite transaction.

Cache revalidation and response construction occur after the commit boundary.
Cache failures are logged and the upload still redirects to the imported space.
A response/connection failure cannot undo committed content: inspect the space
list before retrying to avoid creating a duplicate import.

## Limits and recovery

This is exception recovery, not a distributed or crash-atomic filesystem/database
transaction. Process termination, power loss, another process modifying uploads,
filesystem errors, and failures of SQLite's own rollback machinery are outside
that guarantee. Files finish writing before database commit, so a crash can leave
unreferenced files. No durability claim beyond SQLite/filesystem configuration is
made. An empty uploads directory may remain after rollback.

If unlink fails, or a created file's identity cannot be recorded or no longer
matches, the error says **attachment cleanup incomplete**. The database operation
failed; files that could not safely be removed are deliberately left in place.
Inspect server errors and use the existing upload sweep/recovery procedure after
checking live references. Never delete uploads directory-wide. Back up data and
follow the sweep's quarantine workflow instead. Operators should treat disk and
SQLite errors as requiring investigation, not assume every rollback succeeded.

`npm run test:import-rollback` uses synthetic imports and isolated temporary
SQLite/filesystem fixtures. No user database, deployed server or external URL is
needed. It is required by both CI and release verification.
