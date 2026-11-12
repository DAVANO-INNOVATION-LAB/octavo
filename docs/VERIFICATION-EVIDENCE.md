# Reproducible verification evidence

Run `npm ci`, `npm run build`, then `npm run evidence` with Node 22 and Chrome/Chromium installed. These checks use synthetic fixtures, not a running deployment or its user data. Each run gets a new directory under `artifacts/evidence/`; existing evidence is never overwritten. Set `OCTAVO_EVIDENCE_DIR` to choose a private output directory.

The bundle includes:
- source commit/tree, working-tree status, application version, dependency-lock SHA-256 and Node/OS/architecture;
- synthetic import receipts, imported search indexing, API/space access, restore failure handling and standalone browser-offline gates;
- command, duration, exit code, timeout, status and hashed log for every executed gate;
- browser artifacts when available and a `manifest.json` inventory with byte sizes and SHA-256 checksums.

A failed gate does not suppress later gates. Logs are retained and the command exits nonzero. Each gate has a five-minute timeout. `--source-only` omits the browser/build check and marks the bundle **incomplete**, not passed. CI uploads bundles even after a gate fails. Inspect all gate results, not just the last console line. Interruption can leave a partial report without a final manifest; that is not complete evidence.

Run `npm run evidence -- --verify <bundle-directory>` to detect missing, added or altered files against the manifest. A verified inventory does not mean the recorded tests passed, and an attacker able to replace both files and manifest can forge it.

For repeatability, use a clean checkout at the recorded revision and `npm ci`. A dirty checkout is labeled and cannot be reproduced from its commit alone. The report does not copy source changes or environment-variable values. It is not a signed attestation: hashes detect changed files only when checked against a trusted manifest. Review logs before sharing; custom tests or environments can emit sensitive material.

`OCTAVO_IMAGE_DIGEST=sha256:<digest>` can record a caller-supplied image identity. It is explicitly **untested**: this runner executes source tests and a local standalone build, not that container image. No image digest is invented when one is unavailable.

## Boundaries

The offline gate blocks browser HTTP(S) requests outside its loopback test origin. It does not block or measure server egress, DNS, host networking, optional connectors or model endpoints. It is not an airgap assessment. Restore checks use synthetic files and injected failures, not a target-system disaster recovery drill. Access gates sample application boundaries, not every authorization path.

Target installation, host-level egress isolation, resource measurements, operational recovery and security accreditation remain explicitly **not run**. Passing this bundle establishes only the listed checks. No deployment, certification, hardware qualification or operational acceptance is implied.

## Rollback

This feature adds development/CI scripts and artifacts only. It does not migrate application data. Reverting the release removes the commands without altering documents or permissions. Evidence directories remain available unless explicitly removed by their owner.
