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
  retain their existing cross-tenant access. Instance-agent roles and direct
  space-agent memberships retain their read/propose ceiling; these routes grant
  no new permissions.
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

## Agent group grants (v0.27.7)

An AI Agent group grants **read and propose**, without commenting, writing,
publishing, merging or administration. Previously, agent-only groups opened a
private space for reading but could not propose there; on public spaces they
fell back to ordinary signed-in commenting rights. The group grant now gives
consistent read/propose capabilities in both cases.

Group grants are additive: admin, editor and reader groups win over an agent
group, and an agent group never reduces a stronger direct human membership or
an instance administrator’s rights. This includes deleted-space recovery for
otherwise authorized administrators. In contrast, an **instance AI Agent role**
or **direct AI Agent space membership** is an explicit read/propose ceiling,
including when admin groups are present. Use those direct/instance roles when
an account must be restricted, rather than relying on membership of an agent
group. Removing the last grant removes private-space membership; public spaces
still use their normal signed-in fallback when no grant remains.

Tenant boundaries, missing/deleted-target denial, and visitor limits are
unchanged. No stored role, membership, schema or dependency migration is needed.
Upgrade every running replica to apply the corrected group resolution.

`npm run test:group-grants` uses disposable SQLite data and the real permission
helpers, proposal/settings/recovery actions, comments POST and page PATCH routes.
It covers direct and group combinations in both insertion orders, instance roles,
public/private spaces, tenant inclusion/exclusion, deleted recovery, missing
targets and revocation. Denied mutations must leave all database/audit state,
cache invalidation and audit forwarding unchanged. The gate runs in CI and
release verification. It is a focused authorization regression, not a full
application security audit.
