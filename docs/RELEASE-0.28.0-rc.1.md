# Octavo 0.28.0-rc.1 validation and scope

This is an evaluation release candidate, not a production-ready automatic synchronization service.

## Integrated scope

- Original-space repository reconciliation and revision-aware editor saves.
- Server-owned collaboration projection and epoch fencing.
- Signed manual disconnected-site exchange, conflicts, portable page links and reversible deletion recovery.
- Separately opt-in incremental exchange and manual staging review.
- Explicit OIDC role/group mapping, claim-owned grants, file-backed client secrets, bounded new-session lifetime and SCIM deactivation.
- Disabled loopback transport and durable queues remain prototypes, not an app scheduler.

The candidate is based on authentic upstream commit 57a501e2b8ef1c9116aa5fc4ff9b024db07b7b9f, integrating the separately reviewed sync and SSO source snapshots.

## Fresh combined validation on November 15, 2026

Mac / Node 26.5.0, isolated synthetic data:
- Locked dependency install; production dependency audit: zero vulnerabilities.
- 16 secret-source checks, 17 OIDC mapping groups, 10 callback groups, 8 lifecycle groups and settings-cache/rotation checks.
- 12 Helm secret-hook rendering checks, not a deployed-cluster test.
- 28 exchange-core, 13 incremental, 17 inbox, 36 transport/outbox, 49 application, 9 authorization, 21 links, 15 deletion and 7 pagination groups.
- 2 many-head groups, editor revision/save-queue, collaboration epoch/projection and repository regression suites.
- 28 existing deterministic CI commands, plus auth and 172 core checks.
- Production build, TypeScript and full source lint: pass (four warnings).
- 18 real three-site Chrome groups: pass, zero runtime exceptions.
- Workflow actionlint and four registry-free prerelease publication checks: pass.

Combined integration exposed and fixed the exact SSO schema addition in the archival review guard, plus authorization revocation across streaming upload and asynchronous mutation boundaries. Independent source reviewers found no remaining blocker for these scoped changes. This is not a blanket security certification.

## Breaking behavior and deployment cautions

Page PATCH clients must send the loaded revision. Collaboration uses server-owned persistence; disable flags disable it rather than falling back to the legacy writer. GitLab/Bitbucket Cloud outbound repository sync is held until conditional-write guarantees are implemented. Existing unsupported archival schemas safely hold rather than delete data.

Use isolated copies and back up before upgrades. The historical 345-page copy validation and real Keycloak/Vault/Dex validations predate this combined candidate and are not claimed as rerun here. No live deployment or production data was modified.

## Explicitly unfinished

No automatic cross-site network synchronization, real-peer machine enrollment, scheduler, certificate lifecycle, retention/removal workflow, or production fault qualification. Staging is optional, not a mandatory import policy. Local queue bytes are not encrypted at rest. No instantaneous cross-process revocation or exactly-once networking guarantee.

The release workflow marks prereleases and does not replace stable container latest tags or Docker Hub descriptions. Remote Linux/Node22 CI and release artifact builds still need to pass for this exact commit before publication completion can be claimed.
