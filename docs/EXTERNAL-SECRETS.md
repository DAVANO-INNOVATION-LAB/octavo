# External OIDC secrets and identity-provider integration

## Scope

Octavo is an OIDC relying party. Keycloak, Authentik, Dex and Vault's **OIDC
provider** can supply identity claims when configured compatibly. Vault's
OIDC **auth method** instead authenticates users *to Vault*. Vault Agent and
Vault Secrets Operator deliver application secrets; neither transfers Octavo
permissions automatically. All identity/role claims require explicit local
mapping and live-provider testing.

The external-secret file option is independent of SSO claim mapping. This
document does not assert live Vault interoperability or automatic revocation.

## File delivery

Set `OCTAVO_OIDC_CLIENT_SECRET_FILE` to a readable local file mounted from a
Kubernetes Secret, CSI driver, or Vault Agent. Do not also set
`OCTAVO_OIDC_CLIENT_SECRET`. File contents are read on each settings lookup;
the OIDC discovery cache changes when the secret changes. Files must contain
valid UTF-8, at most 64 KiB, with no NUL byte; one trailing line ending is
removed. Empty/unreadable files fail closed, never falling back to an older
database credential. Atomic replacement of a file is recommended.

Without a file, existing environment-over-database behavior is unchanged.
Environment-variable delivery requires a pod restart after rotation. Mounted
Secret files must not use `subPath` if volume updates are expected to propagate.
The provider's rotation policy must retain the old credential until the new
one is available to Octavo, or a brief sign-in outage may occur. Existing local
sessions are unaffected by an OIDC client-secret rotation.

## Helm example: existing Kubernetes Secret

The Secret must already exist in the release namespace. Provision it through
the chosen secret-management system, not by committing credentials to values.

```yaml
extraEnv:
  - name: OCTAVO_OIDC_CLIENT_SECRET_FILE
    value: /run/octavo-oidc/client-secret
extraVolumes:
  - name: oidc-client-secret
    secret:
      secretName: octavo-oidc
      defaultMode: 0440
extraVolumeMounts:
  - name: oidc-client-secret
    mountPath: /run/octavo-oidc
    readOnly: true
```

The chart's existing `fsGroup` must permit the non-root application to read the
mounted secret. The chart also exposes `envFrom`, `podAnnotations` and
`serviceAccountName` for an existing injector/operator setup. These hooks do not
install Vault, create policies, grant RBAC, or change service account privileges.
Use least-privilege namespace-scoped credentials and a dedicated service account.
Review injector file ownership and ensure no root Vault token reaches Octavo.

## Safe migration from a database-stored credential

1. Preserve the existing configuration and a protected backup. Do not print
   credentials or include production database copies in CI artifacts.
2. Stage the new credential in the external manager and mounted file. Keep
   provider overlap long enough for deployment and verification.
3. Remove the direct secret environment variable, set the file path, and verify
   discovery, real sign-in, role mapping and denied-access behavior on an
   isolated instance before applying to production.
4. Rotate once, verify new sign-in and failure/recovery during file replacement.
5. Only after verification, retire the old provider credential and remove the
   superseded database value through an explicit administrative migration.
   Old backups may still contain the retired credential and must remain protected.

No automatic secret deletion or database-key migration is performed here.
Existing database connector encryption uses a key stored in the same database,
so it does not protect a stolen full database. External delivery avoids adding
the new OIDC secret to that database but does not re-encrypt other connectors.

## Required live tests

- Valid authorization-code/PKCE sign-in with verified email and exact issuer.
- Intended groups mapped to preconfigured least-privilege Octavo roles.
- Removed groups, disabled user, claim absence/type errors and stale sessions.
- Vault provider assignment denial, missing scopes, entity without verified
  email; Authentik ID-token versus UserInfo claims; Dex `groups` scope.
- File missing/empty, atomic rotation, stale provider credential, provider outage.
- Chart-rendered mounts and non-root reads, plus real injected-file rotation.

References:
- https://developer.hashicorp.com/vault/docs/concepts/oidc-provider
- https://developer.hashicorp.com/vault/docs/deploy/kubernetes/injector
- https://developer.hashicorp.com/vault/docs/deploy/kubernetes/vso
- https://docs.goauthentik.io/add-secure-apps/providers/property-mappings/
- https://dexidp.io/docs/configuration/custom-scopes-claims-clients/
