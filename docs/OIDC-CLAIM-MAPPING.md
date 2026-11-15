# OIDC claim mapping (unreleased candidate)

Octavo accepts one configured OIDC issuer. This is login-time provisioning and claim reconciliation, not directory replication or immediate IdP revocation. Existing Octavo sessions remain valid until expiration/local deactivation; disabling an identity in Keycloak alone does not end those sessions. Use SCIM deactivation or local session revocation where immediate removal is required. Provider permissions are never copied blindly: operators configure local groups and their space roles and tenant claim values.

## Configuration

- `OCTAVO_OIDC_SCOPES`: space-separated requested scopes; default `openid email profile`, `openid` always included. Add `groups` if the provider uses that scope.
- `OCTAVO_OIDC_GROUPS_CLAIM`: dot-separated path, default `groups`. String or string-array values only; values match local configured claims exactly (case and leading slash matter).
- `OCTAVO_OIDC_USERINFO=1`: fetch profile claims from the discovered UserInfo endpoint using the access token, strictly bound to ID-token subject. Default off. ID-token values take precedence; email verification must belong to the same email assertion. Conflicting email assertions reject login. Octavo always requires boolean `email_verified=true`.
- `OCTAVO_OIDC_ROLES_CLAIM`: optional dot path, e.g. `realm_access.roles`.
- `OCTAVO_OIDC_ROLE_MAP`: optional JSON exact value map, e.g. `{"octavo-admin":"admin"}`. Values may only be `admin` or `member`. With this explicit mapping, unmatched/removed claims mean `member`, not the old admin-domain fallback. Never map generic realm defaults or all authenticated users to administrator.
- `OCTAVO_OIDC_CLIENT_SECRET_FILE`: external secret mount; see EXTERNAL-SECRETS.md.

Role mapping manages only new OIDC accounts created while mapping is enabled. Existing/local/SCIM/bootstrap/manual-role accounts keep their role ownership; this avoids silently replacing administrator decisions. A manual role edit transfers ownership back to Octavo permanently. Managed role removal takes effect at next SSO login, including existing sessions which resolve current user role from the database. Turning the role-map configuration off does not demote existing accounts; review their roles explicitly. No UI for adopting an existing account into managed-role control is added here.

Group and tenant reconciliation changes only claim-owned memberships. Manual grants survive both matching and disappearing claims. All account, group and tenant updates in a callback are transactional. No arbitrary IdP claim creates a local group, tenant or space grant. Malformed mapped claims reject the entire login.

## Keycloak

Create a confidential OIDC client with exact redirect URI `<Octavo origin>/api/auth/oidc/callback`. Supply verified email and a Group Membership mapper in ID token (or UserInfo with option enabled). Map realm roles using `realm_access.roles`, or configure a dedicated top-level claim. Map only application-specific roles. Existing local/first bootstrap account will not become claim-managed automatically.

## Vault / other providers

Vault's OIDC provider is distinct from its OIDC authentication method. Configure entity metadata and provider scopes to emit verified email and groups. Generic OIDC support alone is not evidence of a tested Vault deployment. Authentik/Dex group claims may require `groups` scope and/or UserInfo. Use provider-specific tests before advertising compatibility. This candidate is being tested separately on local Mac synthetic instances; do not deploy it over production data without review.

## Checks

`node scripts/oidc-claims-test.mjs` tests claim parsing and actual disposable SQLite ownership updates. `node scripts/oidc-callback-test.mjs` tests callback persistence with only network and cookie boundaries mocked. These are not substitutes for browser authorization-code exchange tests against real providers.

## Deprovisioning and bounded session freshness

The SCIM v2 Users endpoint accepts bearer-authenticated PATCH/PUT `active=false`. Account deactivation and deletion of all local sessions commit together; failed session deletion rolls back profile/deactivation changes. Reactivation permits a new login but never restores old sessions. Local password login and SSO login reject deactivated accounts. Configure an actual provisioner to call this endpoint: Keycloak does not automatically call Octavo SCIM merely because a user was disabled. No native Keycloak-to-SCIM bridge is included here.

Optionally set `OCTAVO_OIDC_SESSION_TTL_SECONDS` to an integer from 60 through 86400. This caps **new OIDC sessions** (and their cookie lifetime) at that duration or the shorter instance session policy. It requests OIDC `max_age` and verifies the returned `auth_time` using the OIDC library. A provider that cannot satisfy this request must reject rather than silently bypass it. Leaving the variable unset retains the existing session policy. Local-password session policy is unchanged. Existing sessions issued before a configuration change are not retroactively shortened; revoke those explicitly when rolling out a tighter bound.

This is bounded reauthentication, not continuous introspection or immediate logout notification. An IdP-disabled user may still access Octavo until the existing session expires unless a provisioner deactivates the local account. Active long-lived sockets and already delivered content require separate lifecycle controls; the tested guarantee is subsequent session-authorized HTTP requests, not erasure of data already seen. Backchannel/frontchannel logout, provider refresh-token revocation and per-request introspection are not implemented. Do not advertise automatic immediate IdP revocation.
