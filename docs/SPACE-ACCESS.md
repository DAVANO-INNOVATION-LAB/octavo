# Space access checks

The v0.27.6 release strengthens the server-side access checks on page editing,
space settings, page history/restoration, metadata, variant navigation, raw/print
views and link cards. Capability checks also verify the actual target exists and
is within the current user’s tenant access. Upgrade the running
application, including every replica, to apply the checks. No data migration or
membership changes are required.

## Access behavior

- Editing, history and restoration require both access to the target space and
  write permission. Restoration also verifies that the version belongs to the
  requested target space. Deleted-space recovery retains authorized administration
  while respecting tenant boundaries.
- Space settings and variant changes require both access to the target space and
  administration permission. Editors and readers do not administer spaces. Variant
  suggestions include only spaces the current user can read.
- Tenant membership is checked in addition to space permissions. Instance admins
  retain their existing cross-tenant access. AI principals retain their existing
  read/propose ceiling; these routes grant no new permissions.
- Page metadata follows the reader's access, including valid visitor links. Draft
  metadata requires ordinary space access and write permission. Visitor links
  remain read-only, and cannot reveal drafts through metadata, navigation, raw
  Markdown or print views.
- Variant navigation lists only readable sibling spaces. Draft matching pages
  require write permission in that sibling, independently of the source page.
- Link cards contain page information only for published pages that are readable
  anonymously. Private spaces and tenant spaces receive a generic card, even when
  the request includes a signed-in user's cookie. Cards are generated per request.

## Verification and limits

`npm run test:space-access` runs the real route and action exports with the real
permission helpers and a disposable SQLite database. Framework navigation and
client-component boundaries are isolated. Tests cover allowed and denied roles,
group grants, tenant boundaries, visitor links, missing and deleted targets, and
mismatched identifiers. Denied settings actions must leave database and audit
state unchanged. The suite runs in CI and release verification.

An individual surface can be checked with
`node scripts/space-access-test.mjs editor`, `settings`, `mutation`, `history`,
`metadata`, `card`, `variants`, `restore`, `visitor` or `recovery`. These focused regressions
cover the named surfaces; they are not a full application security audit.

`npm run test:space-access-http` runs against a version-matched production build
with a disposable database and loopback server. Run `npm run build` first. It
checks HTML/RSC responses, real form submissions, metadata and image/cache
boundaries; CI runs it after building.

The checked page, raw Markdown and link-card responses are private/no-store.
Operators should not configure a reverse proxy or CDN to override private/no-store responses. If a
custom cache previously stored page or link-card responses, invalidate those
entries when upgrading. Content already copied into an external chat, browser or
other service cannot be recalled by changing application access.
