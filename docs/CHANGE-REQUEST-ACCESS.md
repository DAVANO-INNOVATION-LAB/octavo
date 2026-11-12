# Change-request access

v0.27.8 strengthens the target boundary around change-request review and proposal
workflows. Upgrade every running application replica to apply these checks. The
release does not migrate requests, reviews, memberships or grants.

## Access behavior

- A change-request action resolves the request's actual space and page before
  changing state. Missing, deleted or unreadable targets are refused. Tenant
  access remains necessary even when a direct or group grant has been retained.
- A change-request detail URL must identify the same space, page and request.
  The page must belong to that space. No diff, description or review is rendered
  until those checks pass.
- The proposal editor and both proposal-creation entry points enforce actual
  target access. Like the ordinary page reader, proposal and review views and
  mutations require write access when their target page is unpublished. Readers
  and AI principals cannot use these workflows to see private drafts.
- For published targets, independent signed-in readers can still approve or
  request changes. They need not be editors or mergers. Existing readable agent
  eligibility is unchanged; this release does not introduce a new review-role
  policy. Reviews do not grant merge or publication permission.
- New review notifications are sent only while the author can still read the
  actual target, including the writer-only draft rule. An authorized review
  still succeeds if its author no longer has access; no new inbox or webhook
  copy is sent to that author. Historical notifications are unchanged.
- Reviews are accepted only while a request is open, never from its author.
  A new review still replaces that reviewer's previous verdict.
- Merge, close and rebase retain their existing role/author requirements, but
  authorship alone does not preserve access after access to the target ends.
- Action navigation, cache invalidation and notification links use the persisted
  target's space/page, not submitted path hints. Review denials happen before
  review writes, timestamps, notifications, outbound webhooks or cache changes.

## Existing requests and reviews

Stored reviews are not deleted or reclassified. They continue to count under the
existing merge policy, including its objection and stale-base checks. This
entry-point hardening does not establish whether historical reviews were
properly authorized. Administrators should evaluate any historical concerns
through their normal incident-review process. No automatic cleanup is included.

## Verification and limits

- `npm run test:change-request-access` exercises the real action, route, API,
  session, authorization, SQLite and notification implementations. Synthetic
  fixtures cover public/private and tenant spaces, retained direct/group grants,
  published/draft targets, readers, editors, administrators, agent principals,
  outsiders, missing/deleted targets, self/terminal review denial, replacement,
  canonical paths and merge controls. Denials compare all database tables and
  audit/notification/webhook/cache effects. Only framework/client boundaries and
  outbound fetch are isolated.
- After `npm run build`, `npm run test:change-request-access-http` runs the compiled
  app on loopback with isolated data and real session cookies. It checks HTML,
  RSC, compiled review/control forms and the proposal API. Notification webhooks
  are intercepted in the test process and never sent externally.
- Both gates run in CI and release verification, alongside the existing access
  and group-grant regressions. Tests do not use live accounts or production data.

This is a bounded review/proposal access change, not a redesign of all content
permissions, an audit of historic actions, or a production deployment test.
