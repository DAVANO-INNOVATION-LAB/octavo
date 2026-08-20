# Changelog

## v0.5.0 — 2026-08-20

### Added

- **Runnable cookbooks** — configure a connector (webhook, Airflow, GitHub
  Actions) in the admin console and code blocks gain a Run button. Isolation
  is enforced, not trusted: a connector works only in the space it is scoped
  to, a run dispatches the *saved* block read from the database (never
  client-supplied text), anonymous runs are refused, credentials are
  encrypted at rest, and every run is logged on the page with who ran it,
  when, and against which page version. Octavo never executes anything
  itself.
- **3D knowledge graph** — a dependency-free force-directed view of the link
  graph with orbit rotation and real depth. It settles then freezes, so
  nodes hold still and stay clickable; drag to orbit, click to open, Reheat
  to re-layout. Ships with a 30-page demo seeder.
- **Smart paste** — spreadsheets land as tables, editor code lands as a code
  block with its language detected, rich text keeps its structure.
- **SSO role rules** — an admin email domain and a default role for new SSO
  accounts, configurable in the admin console.

### Deferred, deliberately

Markdown/Git round-trip sync, content variants, real-time presence, and WAL
replication are each a release of their own; they are next, not half-shipped
here.


## v0.4.0 — 2026-08-20

### Added

- **The docs block library** — callouts in four tones, expandable sections,
  connected numbered steps, and KaTeX display math; a "Docs blocks" slash
  menu group; full Markdown round-trip (GitHub admonitions, details, math
  fences).
- **Page links and backlinks** — type `[[` or `@` to link any page by
  title; published pages show a "Referenced by" rail built from the live
  link graph.
- **Two-factor authentication** — RFC 6238 TOTP for local accounts,
  enrolled from the account page, enforced at sign-in.
- **The binder's office** — an admin console with instance overview and
  health metrics, user management (roles, 2FA reset), one-click consistent
  database snapshots plus per-space export backups, and OIDC configurable
  from the UI (env vars take precedence).
- **Per-space reader typography** — Classic (the permanent default),
  Atelier (serif reading text), Technical (all sans), plus rounded or
  square corners.
- **Hardened container and chart** — slimmer runtime image, healthcheck,
  provenance labels, read-only root filesystem, stricter pod security
  defaults, and a dependency audit gate in CI.

### In progress (begun, landing next)

- Runnable cookbooks (connector-scoped remote execution), Markdown/Git
  round-trip sync, smart paste, and real-time presence.


## v0.3.0 — 2026-08-20

### Added

- **OIDC single sign-on, in core** — four env vars (`OCTAVO_OIDC_ISSUER`,
  `OCTAVO_OIDC_CLIENT_ID`, `OCTAVO_OIDC_CLIENT_SECRET`, `OCTAVO_BASE_URL`)
  turn on "Continue with SSO" against any compliant provider (Keycloak,
  Authentik, Dex, Okta, Entra). Authorization-code flow with PKCE via
  openid-client v6; identities link to existing local accounts by email;
  first-ever user becomes admin, later arrivals are members; optional
  allowed-email-domain gate. Local accounts remain the zero-config default.
  Verified end-to-end against a mock identity provider.
- **Page version history** — a snapshot is kept at most every ten minutes
  of editing (fifty per page), with a history list, read-only version
  views, and one-click restore. Restore always snapshots the state it
  replaces, throttle or not.
- **llms.txt** — an agent-readable index of every public space and
  published page, each linking to its raw Markdown export. AI agents are
  half of documentation reads in 2026; the front door is open for them.


## v0.2.0 — 2026-08-20

### Added

- **Discussion threads** under technical documents, wikis, and articles —
  quiet margin-notes with author attribution; cookbooks deliberately stay
  clean.
- **Named shelves with drag-to-organize**: group spaces under named
  shelves on the library home; signed-in curators drag books to reorder,
  and dropping one onto another shelf's card moves it there. Order and
  shelf persist for everyone. One page, curator's order — never pagination.
- **Book-structured navigation**: docs and cookbooks now read as numbered
  chapters in the sidebar (with recipes/articles/pages labels per space
  kind); article collections stay a flat stack, as separate pieces should.
- **Helm chart** (`charts/octavo`): single-writer Recreate deployment, PVC
  for the SQLite volume, optional ingress, hardened pod security defaults.
- **CI/CD**: GitHub Actions verify (tests, types, lint, build, helm lint)
  on every push; tagged releases build multi-arch (amd64+arm64) images to
  `ghcr.io/davano-innovation-lab/octavo`, package the chart, and publish a
  GitHub Release with notes from this changelog.
- **Test corpora**: 150 real technical documents (arXiv abstracts + classic
  RFCs) and 150 code-heavy ops recipes across Kubernetes, Airflow, Ray,
  Jenkins, OpenShift Pipelines, and Jupyter — the future test bed for
  remote execution.
- **The covenant** in the README — export, privacy, no phone-home, the
  permanent default theme, and nothing load-bearing behind a paywall.


## v0.1.0 — 2026-08-19

The first bound volume. Octavo is an open-source, self-hosted documentation
platform: write like Notion, publish like a book, deploy in one container.

### Highlights

- **Editor**: BlockNote block editor — slash commands, drag handles, tables,
  checklists, images (paste screenshots directly), files, video. Autosave
  with draft → publish flow; published URLs freeze so links never break.
- **Reader**: book-grade published pages — chapter numbering, drop caps,
  numbered space TOC with dotted leaders, "on this page" rail with
  scroll-spy, previous/next page turns, end-of-chapter asterism.
- **Code**: server-side Shiki highlighting for every language, language
  label, copy button, cached rendering.
- **Diagrams**: Mermaid rendering from code blocks (theme-aware); whiteboard
  with Excalidraw (sketch) and draw.io (precise) tabs.
- **Video**: uploads with HTTP range streaming (seekable), plus YouTube and
  Vimeo embeds rendered privacy-friendly.
- **Templates**: 13 space templates — wiki, cookbook, notebook, product
  docs, SRE runbooks, DevOps playbook, API reference, data science, network
  engineering, AI engineering, biological compute, ADRs.
- **Search**: SQLite FTS5 with BM25 ranking, prefix matching, highlighted
  snippets, cmd+K everywhere; private content never appears in anonymous
  search.
- **Spaces**: private by default, public per space; sealed-space messaging;
  infinite page nesting.
- **No lock-in**: export any page as Markdown or PDF (print engine, keeps
  the typography), any table as CSV, any space as a zip of Markdown plus a
  lossless manifest; import Octavo zips, Markdown folders, or single files.
- **Theming**: permanent Paper & Ink default (light + dark), five preset
  palettes, and hidden seasonal themes (Oct–Jan) with hand-drawn SVG
  decorations and rare flybys.
- **Operations**: single Docker container, single SQLite file, local
  accounts with first-run setup, zero external services. `npm test` unit
  suite and a load-test harness (`npm run loadtest`); v0.1.0 baseline:
  300–1,800 req/s per route at p99 < 80 ms on a laptop, zero errors.

### Security

- scrypt password hashing, httpOnly sessions, HTML-escaped search snippets,
  ranged file serving with sniffing protection, SVG served as attachment,
  upload extension allowlist, `npm audit` clean (0 vulnerabilities).
