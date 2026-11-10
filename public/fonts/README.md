# Bundled application fonts

Geist, Geist Mono, Fraunces, and Newsreader are served from `/fonts/`.
`src/app/fonts.css` retains the Google Fonts subset ranges, variable weights,
normal/italic styles, and metric-adjusted fallbacks. No Google Fonts request
is needed during compilation or at runtime.

The standard `npm run build` uses Next.js's supported webpack compiler.
This avoids the Turbopack compilation stall observed in the restricted local
build environment; CI and container builds use the same command.

These unmodified WOFF2 files were recovered from Octavo's existing Next.js
development build cache on 2026-11-10. `manifest.json` records their SHA-256
checksums and family names. The original hashed filenames are retained.
All twenty subsets from that cache are included, not just the Latin subsets.

Upstream sources and licenses:

- Geist: https://github.com/google/fonts/tree/main/ofl/geist — `geist-OFL.txt`
- Geist Mono: https://github.com/google/fonts/tree/main/ofl/geistmono — `geistmono-OFL.txt`
- Fraunces: https://github.com/google/fonts/tree/main/ofl/fraunces — `fraunces-OFL.txt`
- Newsreader: https://github.com/google/fonts/tree/main/ofl/newsreader — `newsreader-OFL.txt`

When updating fonts, replace the binaries and matching CSS ranges together,
retain the licenses, and regenerate the checksums. Font acquisition is an
explicit maintenance step; do not add a download step to the application build.
