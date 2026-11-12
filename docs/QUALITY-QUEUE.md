# Document quality review queue

Open **Document quality** (`/quality`) to find pages you can currently edit,
review their status, and export a metadata snapshot of the filtered queue. This
view is for active human editor accounts. It is not an inventory of every page on
the instance, and reading a page alone does not put it in your review queue.

## Find the work to review

Search by page title or space name, then combine that search with review state
and owner filters. Search is case-insensitive across title and space name, requires
every whitespace-separated search word to match, and accepts up to 200 characters.
It does not search document bodies. **Assigned to me** uses the signed-in person's review-owner
assignment; it does not mean page creator, last editor or last reviewer.
**Unassigned** means no review owner is assigned. The all-owners option includes
pages assigned to other editors as well as unassigned pages.

The matched count describes the currently editable pages satisfying all active
filters. Pagination changes which matching queue rows are shown, not the filter
scope. Rows are ordered by space name, page title and page ID, with 30 per screen
page. Queue links preserve the filters. Forms on the quality screen also carry
the search, state, owner and queue-page context through quality-action redirects.
The detail panel selects a page from the filtered set; a previously
selected page that no longer matches does not keep displaying as if it matched.
An empty result is a reason to adjust filters, not proof that no review work
exists elsewhere.

Review states retain their existing meaning:

| State | Meaning |
| --- | --- |
| Changed | A previously verified title/content revision no longer matches. |
| Overdue | The review due date has arrived, unless the page is already classed as changed. |
| Verified | A recorded review still matches the current revision and is not overdue. |
| Stale | No current verification and the page has not been updated for 180 days. |
| Unreviewed | No current verification and none of the preceding states applies. |

These are workflow states, not a guarantee of factual accuracy, completeness or
production readiness. Filtering, pagination and export do not verify a document
or alter its assignment, publication state or content. Existing review and quality
actions remain separate.

## Review without losing the queue

Quality-screen actions retain structured queue filters rather than accepting an
arbitrary return address. This covers review assignment, revision verification,
approval, space policy, reusable content, feedback triage, runbook checks and
execution evidence submitted from this screen. Existing permissions and action
requirements still apply. If an action changes whether a page matches the filters,
the refreshed detail must come from the remaining matching queue.

**Mark this revision verified** records the selected revision. **Verify and review
next** explicitly records that same revision and then navigates within the
currently matching editable pages. It does not verify another page, publish a
draft, or approve content automatically. Read the selected document before
verifying it; recording a review is not an automated factual check.

Continuation follows the pre-action queue order after the selected page, wrapping
to earlier matching pages when necessary. It rechecks the post-action queue and
skips pages no longer editable or matching. Newly matching pages are fallback
candidates after the surviving earlier candidates. The selected page itself is
never the next candidate; the destination opens on its computed 30-row queue page.
This is not a remembered list of pages visited: with **All statuses** or
**Verified**, previously reviewed pages can remain eligible and appear again.
Use an appropriate review-state filter to work down a particular backlog.

If there is no other matching page, the screen shows **No other matching
documents** instead of automatically reopening the processed detail. This means
no other candidate was available, not that every document is verified or that
work elsewhere is complete. Refresh checks the current queue again; newly
matching pages produce a queue-changed notice and make detail available again.
The processed document can still be opened explicitly from its queue link.

Invalid queue context, a stale revision, a page no longer matching the requested
continuation, or an unsuccessful review prevents advancement. Correct the error
and review the current revision rather than assuming the save succeeded. If the
save committed but navigation or cache refresh failed afterward, the error
explicitly says **Changes saved** and does not claim advancement; refresh the
queue rather than blindly submitting the review again. Ordinary verification
keeps the selected-page context instead of requesting the next page, although a
page that no longer matches is not retained in the filtered detail.

## Export a filtered snapshot

CSV and JSON downloads use the same search, state and owner filters as the queue,
and re-evaluate the current editor scope when requested. They contain selected
queue metadata, not page document bodies. An export can differ from an earlier
screen if a page changes, a review becomes due, or access changes between requests.

Exports include matches across **all queue pages**, not just the visible 30 rows,
up to 5,000 rows in the same order. If there are more matches, narrow the filters
for a complete export. The row cap limits the downloaded metadata; it is not a
limit on the underlying queue scan or its memory use.

JSON includes schema `octavo.quality-queue`, schema version, generation time,
applied filters, editable/matched/exported counts, the limit and a `truncated`
flag. CSV is a header row followed by the same selected metadata columns, without
a metadata preamble. Both formats provide HTTP headers
`X-Octavo-Export-Truncated`, `X-Octavo-Matched-Rows` and
`X-Octavo-Exported-Rows`. A saved CSV file alone does not retain those headers;
check the queue's cap warning or keep the JSON report when completeness matters.

The eleven row fields are `pageId`, `title`, relative editor `href`, `spaceName`,
`spaceSlug`, `published`, `reviewState`, `ownerId`, `dueAt`, `verifiedAt` and
`revision`. Owner IDs are identifiers, not email addresses. Due/verification times
are epoch milliseconds or null in JSON; empty values represent nulls in CSV.
Generation time is ISO-formatted in JSON. No page bodies, feedback text, runbook
commands, execution evidence or account emails are exported.

The endpoint is `/api/quality/queue`, with `search`, `state`, `owner` and
`format=json|csv`. Invalid export filters or formats are rejected. The screen
instead displays an explicit warning and withholds matching rows, selected detail
and export links until valid filters are applied. Downloads use private, no-store caching.

Exports are intended for review tracking, not backups or full document transfer.
Treat titles, space labels and review assignments as potentially private when
sharing a downloaded file. The export feature does not grant recipients access
to the destination pages.

CSV quotes every cell, doubles embedded quotes and uses CRLF record separators.
Values beginning with a formula marker (`=`, `+`, `-`, `@`), including after leading
whitespace/control characters, receive a leading apostrophe to mark them as text.
This is a precaution for common spreadsheet behavior, not a guarantee across every
spreadsheet program or later transformation. Preserve text interpretation when
opening or converting the file; use JSON when exact unmodified string values are
important. Neither format executes content or changes the source documents.
