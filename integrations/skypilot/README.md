# Optional SkyPilot bridge

Octavo submits jobs from published JSON code blocks through an administrator-configured connector. Writers can submit, refresh logs/status, and cancel jobs; readers and agent accounts cannot execute them. Submission acceptance is not completion. Configure Ray with its Jobs API address, or SkyPilot with this bridge's address and bearer token.

Run this service separately from Octavo with Python 3.12 and `pip install -r requirements.txt`. Set `OCTAVO_JOB_TOKEN` to a random secret of at least 32 characters, then run `python bridge.py`. Bind defaults to loopback port 8787. Use a TLS reverse proxy with network access controls for remote access. Keep Ray's Jobs API private too: it executes code with cluster permissions.

Configure SkyPilot credentials and API server on the bridge host. Octavo does not receive cloud credentials. Restrict infrastructure with `OCTAVO_JOB_ALLOWED_INFRA=kubernetes` and SkyPilot's `allowed_clouds`/`allowed_contexts` settings for local-only operation. Production operators must set resource quotas and spending controls; arbitrary published job code is executable code, not a sandbox.

Ray code block:

```json
{"entrypoint":"python3 -c 'print(6 * 7)'","entrypoint_num_cpus":1}
```

SkyPilot code block:

```json
{"task":{"resources":{"cloud":"kubernetes","cpus":1,"memory":1},"run":"python3 main.py"},"source":{"type":"local","path":"example"}}
```

Sources are optional. `local` paths must reside beneath `OCTAVO_JOB_SOURCE_ROOT` on the bridge host, not the browser's computer. `git` takes an HTTPS `url` and full pinned `commit`; hosts must appear in comma-separated `OCTAVO_JOB_GIT_HOSTS`. GitHub, Bitbucket Cloud and Data Center repositories can be used this way. Configure private repository credentials on the bridge host; Octavo's repository connector credentials are not forwarded. `archive` accepts a base64 ZIP, limited by the 100 KB document manifest limit and 20 MB expanded size. Symlinks and escaping archive paths are rejected. Ray supports its native `runtime_env.working_dir` artifact mechanism; it does not use the bridge's `source` field.

Never put tokens, cloud keys, or passwords in documents or job output. Documents and logs are visible to authorized space users. Store secrets in the execution environment. Jobs are durably identified in the bridge database; restarting does not replay pending submissions. If a submission was interrupted, reconcile the stored SkyPilot request ID with the API server before retrying. This bridge supports managed jobs, not long-running SkyServe services.

Benchmark imports are CSV snapshots with source links and test conditions, not live Grafana monitoring. Bitbucket Data Center supports snapshot imports; repository write-back remains disabled. OIDC providers must supply a verified email claim; existing identities cannot be relinked by changing their email.
