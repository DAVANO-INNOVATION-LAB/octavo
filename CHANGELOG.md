# Changelog

## v0.15.0 — 2026-08-26

### Added

- **Citable records.** Configure Zenodo or DataCite once, and anyone who can
  publish in a space can mint a DOI for a published page. The page then shows
  "Cite this page as…", and authors' ORCID iDs travel with the deposited
  metadata as proper name identifiers.
- The record names the **exact revision** that was deposited, so "what does
  this DOI point at" has an answer after the page moves on. Minting is
  append-only and audited: a DOI cannot be withdrawn, only superseded, so the
  flow is deliberate rather than a button anyone can hit by accident.
- Provider tokens are encrypted at rest with the same AES-256-GCM used for
  connector credentials, and are never shown back to the browser.
- A new suite (`npm run test:doi`) exercises both providers' real protocols
  against a stub — Zenodo's three-step create/metadata/publish and DataCite's
  JSON:API deposit — including every failure path, because a DOI cannot be
  un-minted and this feature must never be tested against production.
## v0.14.0 — 2026-08-26

### Added

- **ORCID on authorship.** A page carries a byline — who wrote it, who last
  revised it — and a researcher's ORCID iD appears beside their name, linked
  to orcid.org. Signing in through ORCID fills the iD in automatically, since
  the sign-in itself is the proof; anyone else can set theirs on the account
  page.
- iDs are validated by their **ISO 7064 check digit**, not merely by shape. A
  mistyped iD points at a stranger, which is worse than no iD at all, so an
  iD that does not verify is refused with a message rather than stored.
- Pages now record who created and who last saved them. Pages that predate
  this show no byline rather than a guessed one.
## v0.13.0 — 2026-08-26

### Added

- **References.** Paste a BibTeX file into a space, cite an entry anywhere in
  it with `[@key]`, and the page grows a numbered References section in the
  order it cites them — linked by DOI where there is one. In-text citations
  render as numbered links into that list. A key with no matching entry keeps
  its number and says so in the list rather than disappearing: a missing
  citation is a fact the author needs to see.
- The BibTeX reader is dependency-free, like the YAML and XML readers beside
  it. It handles what real .bib files contain — braced and quoted values,
  nested braces protecting capitalisation, `@string` macros, `#`
  concatenation, and LaTeX accent escapes — and a malformed file yields what
  could be read rather than an exception.
## v0.12.0 — 2026-08-25

### Added

- **The knowledge graph is navigable.** Filter it by space with chips, search
  to locate a page — matches light up and the rest recedes, Enter opens the
  one you meant — and switch clicking from "open" to "focus" to see a single
  page's neighbourhood with everything else dimmed. Filtering re-lays the
  graph out; searching and focusing deliberately do not, so the shape stays
  put under you.
- **An icon set for pages and spaces.** Forty line marks across five groups —
  documents, engineering, operations, science, organisation — replacing the
  initial-letter monogram wherever one is chosen. Not emoji: emoji render
  differently on every platform, carry tone this product does not want, and
  age badly in a document meant to be read for years. The set is curated and
  closed, so a hand-edited database cannot inject an arbitrary glyph.
## v0.11.0 — 2026-08-25

### Fixed

- **Sign-in now works in Safari on a self-hosted instance.** Session cookies
  were marked Secure on any production build, including one served over plain
  http on an internal network — Chrome stores such cookies, Safari correctly
  refuses them, so sign-in appeared to fail. The Secure flag now follows the
  actual request protocol. Anyone running Octavo over http behind their own
  firewall was affected.
- Every JSON API route now rejects a malformed or `null` body with 400 rather
  than 500. A hardening pass, driven by a new adversarial test suite.

### Added

- **Editor: four new blocks.** A *sketch* block (Excalidraw drawn in the page,
  saved with the page, shown to readers as a plain image); an *embed* block
  that shows another page's current content, resolved with the reader's own
  permissions and safe against cycles by construction; an *audience* block
  that appears only when a space variable matches; and page *covers* — six ink
  washes or an uploaded image.
- **Space variables.** Define values once per space; write `{{name}}` anywhere
  and readers see the value, or gate whole blocks on a match. One page,
  dressed per audience or per deployment.
- **An adversarial test suite** (`npm run test:breaking`): 19 probes that try
  to break the app with malformed input, SSRF evasion, forged permission
  boundaries, oversized beacons, concurrent writes, pathological documents,
  and injected markup. Every probe must fail safely.
## v0.10.0 — 2026-08-25

### Added

- **Confluence import.** Upload the XML space export Confluence's own backup
  produces — Space Settings → Export — and the whole space arrives: every
  current page, the page tree, code macros with their language, info and
  warning panels as callouts, task lists as checklists, tables, bold and
  links, and the attachments, served from your own disk. Historical versions
  and trashed pages are left behind on purpose; Octavo starts its own history
  at import. The import lands as a private space: your data, on your disk,
  from the first second.
- **Import from a URL.** Paste an address, get the article as a page in a new
  private space. The fetch is fenced — public web addresses only, never
  anything inside your own network, redirects checked hop by hop, and AI
  agents cannot trigger it at all.
- Both doors run on a new dependency-free markup engine, unit-tested against
  Confluence storage format and sloppy real-world HTML alike, with the rule
  that an importer's job is to rescue the words, never to grade the markup.
## v0.9.0 — 2026-08-25

### Added

- **Highlights.** Select any passage while reading and press Highlight; it
  stays painted for you on every visit, and "My highlights" collects
  everything you marked across the library, linking back to each passage.
  Highlights are the reader's alone: every query is scoped to the signed-in
  account, and there is no route, parameter, or role that returns anyone
  else's. Clicking a highlight removes it.
- **Read replicas and a warm standby.** A process started with
  `OCTAVO_REPLICA=1` follows the snapshots the primary ships, serves the
  library read-only, and refuses writes at the database connection itself —
  not by every route remembering to check. Any number of replicas can sit
  behind a load balancer; promotion is restarting one without the flag.
  One writer, always: SQLite has a single writer and pretending otherwise
  is how systems get quietly corrupted. Every pulled snapshot is
  integrity-checked before it is swapped in, and the whole loop — signing,
  ship, pull, verify, refusal of a corrupted object — runs as its own test
  suite against a local stub, with the signature checked against an
  independent derivation.
- **A demo instance nothing can break.** `npm run demo` stages a frozen
  copy of the build and data on its own port, prunes scratch and internal
  spaces from the copy, and is untouchable by rebuilds, test suites, and
  other sessions. `npm run demo:stop` ends it.
- **Error pages in the product's own dress.** A route that throws now shows
  a calm page with a retry button rather than a bare "Application error"
  screen, and even a failure in the root layout falls back to a styled
  last-resort page.

## v0.8.0 — 2026-08-24

### Added

- **Visitor links.** A private space can be opened to someone outside the
  library — read only, that one space only, until the link expires or is
  revoked. The link is shown once at creation; only its hash is stored, so a
  copy of the database yields no working links, and revocation takes effect
  on the visitor's next click.
- **Groups.** Grant a role in one or more spaces to a set of people at once,
  by hand or carried by the identity provider's `groups` claim — accounts
  are added and removed on sign-in as the claim changes, while grants made
  by hand inside Octavo stay put. A group never takes away what a direct
  membership grants, and the AI-agent ceiling still cannot be escaped
  through one.
- **SCIM provisioning.** The identity provider can create accounts and
  deactivate leavers at `/api/scim/v2`, authenticated with a rotatable
  bearer token. Deactivation ends the person's sessions immediately and
  keeps the account, so someone who returns gets their history back.
- **Instance policy.** Session length, lockout threshold and window,
  minimum password length, and audit-log retention are now settings.
  Lockout counts failures per account inside a sliding window and pauses
  the account rather than the address.
- **Personal data export and erasure.** One click downloads everything the
  instance holds about a person as JSON; deleting an account now also
  removes their sessions, memberships, group seats, comments and
  notifications. The export states plainly what remains and why: audit
  entries keep their recorded actor name because rewriting them would break
  the hash chain for every later entry.
- **Replication.** A verified snapshot of the database ships to
  S3-compatible object storage on a cadence — AWS, MinIO or R2, including
  an air-gapped MinIO. Every snapshot is opened and integrity-checked
  before upload; restore is fetching one file. SigV4 is implemented in the
  codebase itself, keeping the dependency count where it was.
- **Imports.** Word documents (`.docx`) and Jupyter notebooks (`.ipynb`)
  import directly — notebooks keep cell order, code, text outputs and
  figures. Markdown zips already covered MkDocs, Wiki.js and BookStack
  exports.
- **Lab notebook and protocol templates**, for benches rather than
  engineers: dated entries with conditions and results, and procedures
  written to be followed with review carrying the version of record. The
  SSO page documents signing in with ORCID.
- **Social preview cards.** Links to public pages unfurl with a rendered
  card, produced by the instance itself with no external service. Private
  spaces deliberately get a plain wordmark card that names nothing.
- Links into a collapsed section now open it on arrival, so anchors,
  comment threads and reading-report links always land somewhere visible.
- The accessibility audit runs as checks in the browser suite on every
  release: alt text, labelled controls, heading order, and icon-only
  buttons carrying names.

### Fixed

- Adding someone to a space as a Reader or AI Agent actually adds them with
  that role. The form offered four roles and the server kept two, silently
  granting write access to the other two choices.

## v0.7.0 — 2026-08-23

### Added

- **Where readers stumble.** A page is written by the person who least needs
  it, so its author cannot see which sentence is hard. Octavo now watches
  where readers slow down, scroll back, and stop, and shows the writer those
  passages ranked, with a link straight to the editor at the passage that
  failed. Every documentation tool in this category asks the reader to press
  a thumb; response rates to those buttons run at a few percent, because a
  thumb asks the reader to pass judgement on a whole page. Nothing is asked
  here. Re-reading a paragraph three times is a stronger statement about that
  paragraph than any button, and it costs the reader nothing to make.
- Reading signals are **anonymous by construction, not by policy.** The table
  has no column for a user, a session, or an address — “did this person read
  this page” is a question the schema cannot answer, whoever asks it. Only
  people who can edit a space see the signals for its pages, readers who send
  Global Privacy Control are not measured, time accrues only while the tab is
  actually in front, and an administrator can switch the whole thing off in
  one click, which also deletes what was already collected. Retention
  defaults to 90 days and is enforced by the code that writes, not by a cron
  someone has to remember to set up.

### Changed

- Every rendered passage now carries its own identifier in the page, so
  anchored comments, reading signals and future passage-level features all
  address the same thing.
- ESLint no longer parses the vendored diagram assets. It was exhausting its
  heap on them, which meant the linter had not actually run to completion.

## v0.6.13 — 2026-08-23

### Changed

- **Space membership now governs what a signed-in person can see.** A private
  space, its pages, its raw Markdown, its exports, its search hits, its graph
  nodes and its place on the shelf are visible to its members and to the
  instance administrator, and to nobody else. Every read path resolves the
  same set of readable spaces and filters in SQL rather than after the fact,
  so a surface cannot be added later that quietly skips the check.
- **Writing is a capability, checked where the write happens.** Saving a page
  requires `write` in that page's space; rearranging the library shelf, which
  everyone sees, requires an administrator; running a connector requires being
  able to read the page it hangs on. The AI-agent ceiling is enforced on the
  routes that have no space to check against — creating a space, uploading,
  and running a connector — so an agent proposes and never acts.
- Drafts are shown to the people who write them rather than to everyone with
  an account.

### Added

- The integration suite gained a fifth principal who is a member of nothing,
  and 18 checks that hold every one of the rules above over HTTP. It is 44
  checks now, and they run against a real instance.

## v0.6.12 — 2026-08-20

### Changed

- The runtime is a bare Alpine with the Node binary copied in, rather than
  the Node image with its package managers deleted afterwards. Deleting them
  in a later layer removed them from the filesystem but not from the image —
  the bytes stayed in the base layer, still shipped and still readable by
  anything that inspects layers. The image is 38MB smaller as a result.

## v0.6.11 — 2026-08-20

### Fixed

- The Helm chart pulled an image tag that no longer exists. Its `appVersion`
  had been left behind across several releases, and the chart is now stamped
  from the release tag so it cannot drift again.

## v0.6.10 — 2026-08-20

### Added

- **Audit forwarding.** Send audit events to a syslog collector (RFC 5424 over
  UDP, TCP or TLS) or an HTTP endpoint shaped for Splunk HEC. Each event
  carries its hash and the previous one, so a collector holds evidence that
  can be checked against this instance's chain. Delivery is best-effort and
  always after the entry is committed.
- **A signed bill of materials with every release.** CycloneDX 1.5, generated
  from the lockfile, attached to the release and attested through Sigstore
  along with the image itself. Verify either with `gh attestation verify`.

### Changed

- The container is built on Alpine. It is smaller, and it carries no perl —
  which is where every unfixed vulnerability in the previous base was
  concentrated.

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
