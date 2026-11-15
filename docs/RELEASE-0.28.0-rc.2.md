# Octavo 0.28.0-rc.2

## 0.28.0-rc.2 — Upgrade notes (evaluation prerelease)

- Signed-in users see bundled release notes after an upgrade and can reopen release history from the footer.
- Acknowledgements persist per account across browsers. Skipped-version notes are included; downgrades do not reset acknowledgement.
- Version and account binding prevents an old browser tab from acknowledging a different release or account.
- Manual theme choices override seasonal colors and persist after reload.
- Native modal keyboard handling, readable mobile layout, and retry/close controls for failed saves.

Upgrade: back up the SQLite database and uploads. This adds no schema migration and changes no document content. Existing accounts with no acknowledgement see the bundled release history once. Release history currently starts with 0.28.0-rc.1. Notes are bundled locally, with no external fetch.

This remains an evaluation prerelease. Signed manual exchange and SSO are included; automatic cross-site transport is still a disabled prototype. No production readiness claim, automatic deployment or stable `latest` replacement.
