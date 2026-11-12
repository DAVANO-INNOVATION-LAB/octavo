# Referenced assets in Markdown and Notion ZIP imports

New Markdown/Notion ZIP imports preserve supported, locally bundled assets that
Octavo's parser recognizes as references in imported content. This is not a copy
of the entire archive and is not a guarantee of full CommonMark or Notion fidelity.
Files that are merely present in the ZIP are not automatically uploaded.

## Resolution and storage

References are resolved relative to the Markdown file's **original archive path**,
before page names and paths are converted into Octavo's page hierarchy. Repeated
references to the same resolved archive entry reuse one uploaded file rather than
creating a copy for every reference. Identical bytes in different archive entries
are not necessarily the same asset.

Copied files receive generated storage names rather than using archive paths as
filesystem destinations. Recognized references are rewritten to Octavo file URLs.
Query strings and fragments on rewritten references are retained. Recognized file
extensions are kept; other extensions are stored as `.bin`. SVGs are served as
attachments rather than rendered inline. Renaming is not file-content validation
or malware scanning. The files are attributed to the destination space and importer as part of the
import transaction. Knowing a generated URL is not a permission: the existing
upload rules still require access to the recorded origin and appropriate published
references. Draft-only attachments do not become anonymously readable because they
were imported.

## Scope and limits

The asset walker operates on parsed block `props.url` fields and inline link
`href` fields, including nested content, child blocks, table rows and cells. It
does not search or rewrite raw Markdown or code examples. Parser limitations,
including syntax that never becomes one of these fields, remain outside this
feature's coverage; full CommonMark support is not implied.

Missing targets and references that the asset resolver does not handle are left
unchanged by that resolver. The report flags remaining recognized relative
references for review, and retains available preview warnings. It cannot guarantee
a specific warning for every unsupported source construct. Malformed percent
encoding is left unchanged; valid percent-encoded paths are decoded for lookup.
Root-absolute URLs, fragments, external URLs and links to Markdown pages are not
attachment uploads. External resources are not fetched or archived.

The default copy limits are:

| Limit | Default |
| --- | --- |
| One copied asset | 20 MiB |
| Total copied asset bytes per import | 100 MiB |
| Distinct copied assets per import | 1,000 |

These limits apply to copied assets, not every archive entry. They do not replace
existing upload, ZIP parsing, page-count, or overall import limits. An import that
exceeds the copy limits fails rather than silently omitting excess assets.

The planner validates all archive entry names, including unreferenced entries.
Absolute paths, drive-prefixed paths, backslashes, NUL characters and `..` path
segments in archive names are rejected. Names that normalize to the same archive
path are rejected as ambiguous. A relative document reference can use `..` to
reach a sibling directory inside the archive, but a decoded reference that escapes
the archive root is rejected. Unsafe decoded references are rejected too. Fix the
source archive rather than relying on conflicting names or escaping paths.

## Reports and recovery

The import report distinguishes preview attachment-entry estimates from actual
saved upload records. Unreferenced bundle files can make the preview estimate
larger than the saved count. A shared asset referenced by several pages is saved
once. Review warnings, remaining references, and the rendered destination pages.

Content, file attribution, and the completion report commit together. If an
exception occurs before commit, rollback removes database changes and only the
new files owned by that import attempt. A postcommit cache-refresh failure does
not undo a successful import. This is exception recovery, **not crash-atomic
coordination between SQLite and the filesystem**; an abrupt process or machine
failure can still require operator recovery.

No historical import is reconstructed and no old page is silently rewritten.
Previously imported bundles retain their existing content and references. Import
the original archive again into a new space when you want to use the new asset
handling, then review the result before replacing an existing space.
