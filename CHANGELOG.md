# Changelog

## v0.6.9 — 2026-08-20

### Added

- **API references from OpenAPI.** Import a specification and get a page per
  operation — parameters, request and response shapes, examples, and a panel
  that sends the request from your own browser. The output is ordinary
  blocks, so a generated reference is searchable, exportable, translatable
  and editable like anything else.
- **Answers from your library, with citations.** Ask a question and get an
  answer written only from pages you can already read, shown beside the
  passages it came from. The model is your own — anything OpenAI-compatible,
  including one on your own network. Configure nothing and the feature is not
  offered.

### Fixed

- A chapter opening with code no longer takes a drop cap, which had been
  setting a three-line capital across a monospaced token.

## v0.6.8 — 2026-08-20

### Changed

- The image no longer carries the `docs/` directory. Documentation is not a
  runtime asset, and the previous exclusion matched only top-level Markdown,
  so everything under `docs/` was being copied in.

## v0.6.7 — 2026-08-20

### Changed

- Published images now carry a source revision that resolves in this
  repository. The previous images labelled themselves with commits from
  before a history rewrite, which meant the label pointed at something no
  branch or tag referenced.

## v0.6.6 — 2026-08-20

### Added

- **draw.io ships inside the application.** The diagram editor is served by
  this instance rather than loaded from the internet or run as a sidecar, so
  it works with nothing configured, connected or not. `OCTAVO_DRAWIO_URL`
  becomes an override for sites running their own build.

### Changed

- The container is meaningfully smaller despite carrying the editor: a
  recursive ownership change after the copy steps had been duplicating the
  whole tree into an extra layer, and better-sqlite3 was shipping eight
  platforms' prebuilt bindings plus the SQLite sources used only to compile
  them.

## v0.6.5 — 2026-08-20

### Added

- **Real-time co-editing** — two people can write the same page at once, with
  remote cursors, a presence strip showing who else is in the document, and
  reconnection that keeps unsent edits. It runs on the same port as the app,
  so nothing about deployment changes.

### Changed

- Planning and competitive material is no longer published from the
  repository.

## v0.6.4 — 2026-08-20

### Added

- **Anchored comment threads** — a thread hangs from the block it is about,
  with replies, resolve and reopen, and @-mentions. The passage is copied
  onto the thread when it starts, so a thread whose paragraph was later
  rewritten or deleted keeps its quotation and says so.
- **@-mentions** in comments, resolved when the comment is rendered rather
  than stored as markup, so a renamed person is still addressed correctly.
- **Change requests** — propose an edit on its own route, review it against a
  side-by-side Markdown diff, and merge it. Merging is blocked when the page
  has moved since the proposal was written, or when a reviewer has asked for
  changes; nobody reviews their own proposal.
- **Audit log** — a hash-chained record of authentication, account, space,
  page, connector, administration, and change-request events, with chain
  verification, filtering, and JSON-lines export. The head hash is shown so
  it can be anchored outside the instance.
- **Notifications** — an inbox and unread count for mentions, replies, and
  change-request activity, with an optional outbound webhook that Slack and
  Teams accept directly.
- **Four roles** — Admin, Editor, Reader, and AI Agent. The agent role is a
  ceiling rather than a weaker reader: an agent may read and propose and
  never write, publish, merge, or comment, whatever else it is granted.
  Agents propose; people merge.
- **Round-trip Markdown sync** — a space mirrors to a directory of Markdown
  files and reads edits back. Both sides changed is reported as a conflict
  and neither is touched; a missing file never deletes a page. Point the
  directory at a working tree and commit it with your own tooling.
- **Content variants** — versions and translations of one library, linked by
  a group key and switched from the reader. Pages correspond by slug, and a
  variant missing a page says so rather than hiding.
- **Offline operation** — every runtime asset is served from the container,
  `OCTAVO_OFFLINE=1` declares an instance disconnected, and
  `OCTAVO_DRAWIO_URL` points the diagram editor at a self-hosted one. See
  [docs/AIRGAP.md](docs/AIRGAP.md).

### Fixed

- Excalidraw resolved its fonts against a CDN when `EXCALIDRAW_ASSET_PATH`
  was unset, which failed on a disconnected network and leaked a request on
  every other one. Its fonts are now vendored and served locally.
- Deleting a comment required only a signed-in session; it now requires being
  the comment's author or a space admin.
- The reader page action row and the site header both outgrew a 375px
  viewport as controls were added.


## v0.6.3 — 2026-08-20

### Added

- **Raw Markdown for any page** at `/space/page/raw`, plus **llms-full.txt**
  inlining every published page of every public space.
- **SEO plumbing** — a generated `sitemap.xml` and `robots.txt`, canonical
  and OpenGraph metadata on reader pages, private spaces marked noindex.
- **Broken-link detection** — an admin report of internal links that no
  longer resolve: missing spaces, missing pages, and links pointing at
  unpublished drafts. External URLs are left alone.
- **Whole-space PDF export** — a print route that renders the space as one
  book: title page, contents with dotted leaders, then every page with a
  break between chapters.
- **Page analytics, search insights, and reader feedback** — a local,
  cookie-free view counter, the terms readers searched, and a quiet "was
  this helpful?" vote. The insights page answers: what is read most, what is
  read often but stale, what was marked unhelpful, what is never read, and
  what people searched for and *found nothing* — the pages the library is
  missing.
- **Code block polish** — a filename in the header, a highlight spec
  (`2-4,8`) that bands the lines that matter, an automatic line-number
  gutter on longer blocks, and per-reader toggles for numbers and wrapping.
- **Margin notes** — inline annotations that open into the margin on a wide
  screen; Markdown footnotes import as them and export back out.
- **Theme-aware images** — a second source shown only in dark mode.


## v0.6.2 — 2026-08-20

### Added

- **3D models in the page.** A model block renders a rotatable, dependency-free
  3D scene on plain canvas — the same projection engine as the knowledge
  graph. Six disciplines ship: service architecture, network topology,
  delivery pipeline, cell culture over an electrode array, molecular
  structure, and embedding space. **Every engineering template now opens with
  the model for its discipline**, so the capability is discoverable the moment
  a space is created rather than buried in documentation.
- **Restore a snapshot from the admin UI** — upload a database snapshot taken
  from the same page. Admin only, a typed confirmation, the file verified as a
  genuine Octavo database with at least one account before anything is
  touched, and the outgoing database preserved in `/data` so a restore can be
  undone.
- **Screenshot capture over the DevTools protocol** (`scripts/screenshots.mjs`)
  — the `--screenshot` flag hangs on pages that never go network-idle (canvas,
  KaTeX, Mermaid), so captures now wait a per-page settle. The README shows the
  library, a published page, the block library, a runnable recipe, the graph,
  and diagrams.
- **Import a Markdown document as a private space** (`scripts/import-doc.mjs`).

### Fixed

- The UI stress crawler no longer reports drafts and private spaces as
  failures — it runs anonymously, where hiding them is correct behaviour.
- `@types/node` now matches the Node 26 runtime.


## v0.6.1 — 2026-08-20

The v0.6 line continues as point releases.

### Added

- **Draw.io diagrams saved in the page** — a `/`-menu "Draw.io diagram"
  block, the way Confluence does it: create or edit the diagram in a
  full-screen editor, and on save the diagram's source is stored in the
  block while the rendered SVG is saved to the space's file store.
  Published pages show a plain image — no external calls for readers —
  and clicking the block in the editor reopens the diagram for editing.


## v0.6.0 — 2026-08-20

### Added

- **Space admins run their own space** — a second level of authority beside
  the instance admin: space admins manage their space's members and add
  **their own connectors**, scoped to that space and usable nowhere else.
  Instance-wide connectors remain visible but are marked as managed
  elsewhere. This is the shape tenant administration will take when tenant
  namespaces land — a tenant is a group of spaces over the same membership
  table, not a third concept.
- **UI stress harness** (`scripts/ui-stress.mjs`) — crawls every route for
  bad status codes, missing chrome, client-side exceptions, slowness, and
  page weight, so regressions are caught by a command instead of by eye.

### Fixed

- **Branding on every page.** The footer moved into the root layout, so
  "A Davano Innovation Lab product" appears everywhere by construction —
  it had been missing from the graph, whiteboards, and sign-in. The footer
  also now carries a link to the AGPL source.
- **Six mobile layout defects**, found by the crawler and by measuring
  every page at 375px: the header action row overflowed (sign-out is an
  icon on small screens), the admin overview grid and tab row overflowed
  (grid children need `min-w-0`; the tab row now scrolls), and the reader
  page header squeezed long titles mid-word (actions now stack above the
  title). Every page measures clean at mobile width.
- **Library tiles are uniform.** Cards fill their grid cell and every row
  shares one height, so a shelf reads as an even set instead of a ragged
  stack.
- Whiteboards gained real `<main>` landmarks.


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
