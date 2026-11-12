# Choosing a space template

Open **New space** (`/new`), give the space a name, and choose a starting template.
The chooser lets you search the catalog, narrow it by category, and inspect the
selected template's page outline before creating anything.

## Find a starting point

Categories organize the existing catalog into Simple, Presentations and demos,
and Engineering. Use the all-categories option to search across the catalog.
Search matches template names, taglines, audiences and page titles, not the full
text inside template pages. Matching ignores case and accents, and every search
word must appear somewhere in that template's searchable metadata. Filtering
preserves catalog order; it is not a relevance-ranked search.

Filtering does not silently change the selection. If the selected template no
longer matches the search or category, it remains selected and its outline remains
available. Clear or adjust filters to find another template. A no-results state
does not mean the selection was cleared or the catalog is empty. Review the
selected template before submitting the creation form. **Clear filters** resets
search and category without changing the selection. **Use default template**
restores the default choice and clears the filters.

## Understand the outline

The selected outline is derived from the actual template catalog. Its page count
includes child pages recursively, and its hierarchy describes the pages that will
be created. It is **not** a slide count or an outline of headings and blocks within
a page. For example, a presentation template may contain one page with multiple
sections used by Present mode.

The chooser receives catalog metadata and page titles, not template document
bodies. Page content is supplied by the existing server-side creation path after
you submit. The preview does not create a space, publish pages or execute anything
mentioned in a template.

## Create and review

Choose the desired space visibility separately from the template. The existing
creation behavior is unchanged: the creator administers the new space, and seeded
template pages start as drafts to review, edit or delete. Choosing public space
visibility does not automatically publish those drafts. Creation opens the first
seeded page in the editor when available.

A template provides a starting structure, not a guarantee that its guidance fits
your project or that its sample integrations are configured. Review page content
and any execution-related instructions before using them.

## Interaction and verification

Search and category controls are labeled, and native radio controls allow
templates to be selected without a pointer. Use Tab to move between controls and
arrow keys to move within the template choices. Enter in the search field does
not submit the creation form. The selection summary and page outline are designed to remain readable
on a phone; a narrower screen does not remove the selection or change what the
form submits. Check the selected summary after filtering and before creation.

Functional tests compare metadata counts and outlines with the source catalog,
exercise search and category combinations, and verify that filtering preserves the
selected template. Browser tests exercise desktop/mobile and keyboard interaction
against the built application; passing metadata tests alone is not visual QA.
