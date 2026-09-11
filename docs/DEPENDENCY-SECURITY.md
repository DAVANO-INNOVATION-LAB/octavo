# Dependency security maintenance

The CI `npm audit --audit-level=high` gate remains required. Do not suppress it
to accommodate a lockfile finding.

## September 2026 remediation

The lockfile previously reported 13 findings (10 moderate, 3 high). The focused
update selects js-yaml 4.3.2, sharp 0.35.4 (and its matching native packages),
and Tiptap 3.30.5.

Tiptap packages declare exact-version peers. Updating only core, or running
`npm audit fix`, left the old core selected and could mix menu packages with
incompatible peers. The package.json overrides therefore keep all twelve
installed Tiptap packages on the same minimally patched 3.30.5 release. This
release satisfies BlockNote 0.54.0's existing ^3.29.2 dependency ranges; no
BlockNote, Next, or React major upgrade is included. Revisit these pins together
when upgrading BlockNote, and require a clean peer tree and editor regression
validation before removing them.

Scope and reachability:

- Tiptap is used through the BlockNote editor. The update addresses
  [attribute prototype pollution](https://github.com/advisories/GHSA-cp6q-959q-f8rh)
  and [Markdown attribute ReDoS](https://github.com/advisories/GHSA-j95f-988m-3j2f).
  Dependency presence alone does not establish an exploitable application path.
- [js-yaml merge-source CPU exhaustion](https://github.com/advisories/GHSA-2883-xcg3-v3hh)
  is in the development ESLint dependency tree, not an application YAML import.
- [sharp/libheif findings](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c)
  concern Next's optional image dependency. Octavo disables the image optimizer
  with `images.unoptimized: true` and does not use `next/image`; the update is
  defense in depth, not evidence that an exposed image-processing path existed.

Validation should include `npm ci`, `npm audit --audit-level=high`,
`npm ls @tiptap/core @tiptap/pm @tiptap/react sharp js-yaml --all`,
`node scripts/auth-token-test.mjs`, `node scripts/test.mjs`, `npx next typegen`,
`npx tsc --noEmit`, `npx eslint src`, and `npm run build`. Browser editor and
database-backed behavior still need their applicable integration environment;
an audit with no findings does not certify the application secure.
