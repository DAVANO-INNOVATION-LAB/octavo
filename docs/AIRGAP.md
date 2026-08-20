# Running Octavo on a disconnected network

Octavo is built to run with no route to the internet. Everything it needs at
runtime ships inside the container: the database engine, the fonts, the syntax
highlighter, the whiteboard, the collaboration server, and the draw.io
diagram editor itself. There is nothing to run alongside it.

There is a check that proves it rather than asserting it — see
[Verifying it yourself](#verifying-it-yourself) at the end.

## Getting the image across

The image is published to a registry, so move it as a file:

```bash
docker pull ghcr.io/davano-innovation-lab/octavo:latest
```

```bash
docker save ghcr.io/davano-innovation-lab/octavo:latest -o octavo.tar
```

Carry `octavo.tar` across, then on the isolated host:

```bash
docker load -i octavo.tar
```

## Running it

```bash
docker run -d --name octavo -p 3000:3000 -e OCTAVO_OFFLINE=1 -v octavo-data:/data ghcr.io/davano-innovation-lab/octavo:latest
```

`OCTAVO_OFFLINE=1` tells Octavo there is no internet. It does not restrict
anything you can otherwise do — it changes the two features that would
otherwise reach outside, so they explain themselves instead of hanging on a
request that cannot complete.

The container needs no outbound access, and nothing phones home. Build
telemetry is disabled in the image, and the runtime has no package manager in
it at all.

## What works with no network

Everything the platform is for:

- Writing, publishing, and reading — the full block editor and book-style
  reading experience
- Full-text search (SQLite FTS5, in-process)
- Syntax highlighting for every bundled language
- Mermaid diagrams, KaTeX math, and the 3D model blocks
- The freehand whiteboard, including all nine of its font families
- **draw.io** — the editor itself ships inside the image and is served by
  this instance, so creating and editing diagrams needs no network and no
  second container
- PDF and Markdown export, space export and import, backups and restore
- Local accounts with two-factor authentication

## Video embeds

A page can embed a YouTube or Vimeo video by URL. Those players live outside
your network, so Octavo shows the address in place of the frame rather than
leaving one spinning.

Video files you upload to Octavo itself are served from your own instance and
play normally.

## Single sign-on

OIDC works offline as long as the identity provider is on the same network —
Keycloak, ADFS, Entra ID via an internal endpoint, or anything else that speaks
OIDC. Octavo contacts only the issuer URL you configure. There is no dependency
on any external service.

## Backups

The whole instance is one SQLite file. Back it up from the admin UI, or copy
the data volume. Restore is uploading the file back through the admin UI.
Nothing about this needs a network.

## Verifying it yourself

Do not take the above on trust. The repository includes a check that starts a
browser, fails every request that leaves localhost — exactly what a severed
network does — and then walks the routes that pull the heaviest third-party
machinery, reporting anything that tried to escape.

Run it from a clone of the repository, and pass the address of the Octavo
instance you want checked — not whatever happens to be on port 3000:

```bash
npm run test:airgap -- http://localhost:3000
```

A clean run reports every route rendering and `none. Every asset resolved
locally.`

It needs a signed-in session in the database it reads, so that the editor and
admin routes are actually reachable rather than redirecting to a login page
that would pass the check without exercising anything.

To confirm the container needs nothing at all, start it with no network
interface and ask it from the inside:

```bash
docker run -d --name octavo-nonet --network none -e OCTAVO_OFFLINE=1 octavo:latest
```

```bash
docker exec octavo-nonet node -e "fetch('http://127.0.0.1:3000/login').then(r=>console.log('app responds:',r.status))"
```

If your environment requires evidence for an approval, both commands produce
output you can attach.
