# Resource authorization (v0.27.9)

This release hardens authorization across comments, visitor tokens, attachments,
derived models, exports, feedback, metadata and new notifications. It does not
certify Octavo as compliant with a security standard or replace a deployment audit.

## Upgrade compatibility and recovery

Back up the database and upload volume before upgrading. No stored attachment
bytes, page history, comments, tokens or notifications are deleted by this patch.
Existing memberships and grants are unchanged.

Attachment access now follows the upload's recorded origin, not a filename pasted
into a different document. Current access to the origin is required. Writers can
preview draft and historical attachments; other readers need a current published
page or cover reference in that origin. Removing origin access also removes an
uploader's former access. Unscoped uploads are private to their recorded uploader
and instance administrators until explicitly scoped.

**Legacy attachments without an upload provenance record fail closed.** Mutable historical
references are not trustworthy evidence of ownership. Some old images, model data
and exports may stop rendering for ordinary readers after upgrading. Instance
administrators retain access for recovery; unauthorized direct requests return a
generic not-found response rather than revealing whether a file exists.

For recovery, an instance administrator should verify the original owner and
intended destination using trusted backups or records, retrieve the original
bytes, and reupload them through the normal authenticated upload/import flow into
the intended space. Update the page references and publish only the intended
content. Preserve the old bytes and history while validating the replacement.
Do not infer ownership from arbitrary pasted URLs, bulk grant access from the
reference table, or edit provenance by guesswork. To deliberately share a file
into a different security scope, reupload a verified copy into that scope.

File responses, including partial/range responses, are private and no-store.
Purge any previously public file responses from reverse proxies/CDNs during the
upgrade. New headers cannot retract copies already downloaded or previously cached.

## Boundary behavior

- Comment moderation resolves the persisted comment and its actual page before
  checking authority. Comments and replies require current target access; drafts
  retain writer-only visibility. Empty/invalid replies have no notification side effects.
- Visitor token revocation is atomically scoped to the authorized space.
- Instance AI Agents cannot create spaces/templates. New parent/child page links
  must stay within the authorized space.
- New comment and change-request notifications require the recipient to retain
  target access, including tenant, deactivation and draft restrictions. Historical
  notifications are not rewritten or retracted.
- Page exports use full space authorization including tenant scope. Derived model
  data and bundled files obey the same attachment gate as direct downloads.
- Private-page feedback is not accepted from principals unable to read the page.
- Anonymous unpublished Site metadata and inaccessible saved-highlight labels
  are not exposed; saved highlights themselves remain stored.

## Verification and limits

The regression suites use synthetic users, sessions, tenants, spaces and files in
isolated temporary databases. `npm run test:resource-access` exercises exported
server actions, routes and storage behavior, including authorized positive cases.
`npm run test:action-boundaries-http` and `npm run test:resource-routes-http`
exercise the compiled standalone server over loopback. Existing space, group-grant and change-request suites remain required in
CI and release verification.

The review inventory covered 76 main server actions plus quality actions, 33 API
route files (39 handlers) and 52 page routes, including all three metadata generators. This is a
source/fixture review, not evidence that every possible integration or deployment
is secure. No real customer data, production deployment, external identity
provider, reverse proxy or hosted tenant was used for these tests. External sync
filesystem/network operations were not exercised by the action audit.
