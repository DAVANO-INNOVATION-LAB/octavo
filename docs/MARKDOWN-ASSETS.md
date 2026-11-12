# Referenced assets and page links in Markdown and Notion ZIP imports

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

## Links between imported Markdown pages

New Markdown/Notion ZIP imports resolve recognized relative `.md` page links
using the source document's original archive path. The importer first creates the
destination pages, then rewrites matching links using their **actual assigned
slugs**. It does not guess a destination slug from the filename or heading.

This supports forward links to pages appearing later in the archive, filenames
that differ from page headings, and pages with duplicate titles whose assigned
slugs differ. Notion-style exported filenames are resolved before their display
names are cleaned. For example, a parsed link from `guides/start.md` to
`../reference/options.md` points to the page created from that exact archive
entry, even if its title generates a different destination URL.

Page-link rewriting uses the same parsed URL fields as the asset walker: block
`props.url` and inline link `href`, including nested content and table cells. It
handles `.md` destinations, not arbitrary Markdown-like extensions, raw prose or
code examples. Paths are percent-decoded once for lookup. For Notion exports,
when exact path lookup fails, a unique exported page ID can identify the target;
ambiguous IDs are not guessed. Existing reports use the general remaining-relative-
reference warning rather than a new per-link resolution report.

### Competing index and README documents

For new imports, each folder has at most one primary index document. Selection
is deterministic rather than dependent on ZIP entry order:

1. An `index.md` name, matched case-insensitively, takes priority over `README.md`.
2. Within the same name type, exact lowercase spelling takes priority over other
   case variants.
3. Remaining ties are ordered by the original archive path.

The primary document supplies the folder's page. Other index/README documents,
including additional case variants, are retained as separate child pages instead
of overwriting that content. The same rule applies at the import root: its primary
document becomes the parent of other root documents and nested folder pages.
Without a root primary, those pages remain at the top level.

Each retained source gets its own destination page and assigned slug. Recognized
links to `index.md`, `README.md`, or their case variants therefore resolve to the
corresponding source document, not all to one shared page. Normal title selection
and duplicate-title slug disambiguation still apply; source filenames need not
become displayed titles. Source publication settings remain in effect, so a
retained draft may still be unavailable to readers.

This replaces the older last-wins behavior for competing folder index documents.
It does not recover previously overwritten content or change an existing import.
Import the original archive into a new space to use this behavior, then review the
page tree and links before replacing older content.

Only recognized links with an imported target are rewritten. Unresolved links and
external URLs remain unchanged; the feature does not make every link in every
Markdown dialect work. Markdown page links are not copied as attachment files.
Query strings and fragments are preserved on rewritten links, but preservation
does **not** prove that an imported heading's rendered anchor matches the source
fragment. Open important links and check the intended section after import.

The operation applies to new imports only. Existing pages and previous imports
are not rewritten automatically. Full CommonMark support, lossless Notion
conversion, and complete link validation are not implied.

## Preview before confirmation

For Markdown/Notion ZIPs, the preview may include `assetPlan: { files, bytes }`.
It describes distinct referenced files planned for copying and their total bytes,
not all archive entries and not files already saved. Preview performs planning
without writing uploads. The UI shows a readable size with the exact byte count.

The attachment-entry estimate is separate: an archive can contain many unused
files but have a small referenced-asset plan. A returned plan with `files: 0` is a
zero-file plan; an absent `assetPlan` means no plan is available for that preview,
not zero eventual attachments. Other import formats can still save attachments.
Review warnings before confirming and inspect actual results afterward. A plan
is neither a complete syntax-coverage check nor a conversion-fidelity guarantee.

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
and internal-link handling, then review the result before replacing an existing space.
