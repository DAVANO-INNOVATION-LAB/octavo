# Document ownership and review queue

## First increment

The pure review-state and completion functions are implemented in
`src/lib/document-review.ts` and covered by `scripts/document-review-test.mjs`.
CI executes those tests. They are foundations, not a user-visible feature yet.

- Verification fingerprints the exact stored title and content.
- Title/content edits invalidate verification even if their timestamps match.
- Completing a review leaves page content and modification time untouched.
- A stale revision cannot be marked verified.
- Completing a review preserves the assigned owner and requires a future due date.

## Remaining acceptance criteria

1. Add review metadata with a forward-only SQLite migration; preserve existing pages.
2. Add an admin review queue to Insights with owner, due date, and review state.
3. Limit assignment to active people who can edit the page's space, including group grants.
4. Recheck authorization and expected revision inside the write transaction.
5. Audit assignments and completed reviews; reject anonymous, reader, and agent writes.
6. Exclude deleted spaces; invalidate verification when title/content changes.
7. Verify migrations, permission failures, concurrent edits, and the complete browser flow.

No schema migration, ownership assignment, or review mutation is activated by
this increment. The current release is v0.26.4; this draft is for the next update.
