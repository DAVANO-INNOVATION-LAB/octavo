// Seeds 150 code-heavy operations documents — the future test bed for
// remote execution (Ray, Airflow, Jupyter, Jenkins, OpenShift Pipelines,
// Kubernetes). 6 platforms × 25 recipes, each with runnable-style code.
// Usage: node scripts/seed-code-corpus.mjs
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import path from "node:path";

const db = new Database(path.join(process.cwd(), "data", "octavo.db"));
db.pragma("journal_mode = WAL");

const A = "0123456789abcdefghjkmnpqrstvwxyz";
const id = () => [...randomBytes(16)].map((b) => A[b % 32]).join("");
const now = Date.now();

const T = (text, styles = {}) => ({ type: "text", text, styles });
const P = (...c) => ({ id: id(), type: "paragraph", props: {}, content: c, children: [] });
const H = (l, t) => ({ id: id(), type: "heading", props: { level: l }, content: [T(t)], children: [] });
const CODE = (lang, src) => ({ id: id(), type: "codeBlock", props: { language: lang }, content: [T(src)], children: [] });
const TABLE = (rows) => ({ id: id(), type: "table", props: {}, content: { type: "tableContent", rows: rows.map((r) => ({ cells: r.map((c) => [T(c)]) })) }, children: [] });

const slugify = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
const textOf = (blocks) => {
  const parts = [];
  const inline = (c) => (Array.isArray(c) ? c.map((x) => (x.type === "text" ? x.text : "")).join("") : "");
  blocks.forEach((b) => { if (Array.isArray(b.content)) parts.push(inline(b.content)); else if (b.content?.rows) b.content.rows.forEach((r) => r.cells.forEach((cell) => parts.push(inline(cell)))); });
  return parts.join("\n");
};

const SERVICES = ["api-gateway", "payments", "ingest-worker", "search-indexer", "feature-store"];
const PIPELINES = ["daily-etl", "model-training", "log-compaction", "invoice-sync", "churn-scoring"];
const MODELS = ["embedder", "ranker", "ocr-parser", "summarizer", "anomaly-detector"];
const JOBS = ["build-api", "deploy-web", "nightly-tests", "security-scan", "release-cut"];
const NOTEBOOKS = ["eda-baseline", "feature-engineering", "model-eval", "drift-report", "ab-analysis"];

const PLATFORMS = [
  {
    slug: "ops-kubernetes",
    name: "Ops: Kubernetes",
    desc: "Twenty-five field recipes for running workloads on Kubernetes — deploys, debugging, scaling, and safety rails.",
    subjects: SERVICES,
    tasks: [
      {
        title: (s) => `Deploy ${s} with zero downtime`,
        intro: (s) => `A rolling update of ${s} that never drops a request: surge one pod, allow zero unavailable, and gate on readiness.`,
        params: (s) => [["Parameter", "Value", "Why"], ["strategy", "RollingUpdate", "replace pods gradually"], ["maxUnavailable", "0", `${s} keeps full capacity`], ["maxSurge", "1", "one extra pod during rollout"]],
        code: (s) => ["yaml", `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${s}\n  namespace: prod\nspec:\n  replicas: 3\n  strategy:\n    type: RollingUpdate\n    rollingUpdate:\n      maxUnavailable: 0\n      maxSurge: 1\n  template:\n    spec:\n      containers:\n        - name: ${s}\n          image: ghcr.io/acme/${s}:1.4.2\n          readinessProbe:\n            httpGet: { path: /healthz, port: 8080 }\n            periodSeconds: 5`],
        verify: (s) => `kubectl rollout status deploy/${s} -n prod --timeout=120s`,
      },
      {
        title: (s) => `Debug a CrashLoopBackOff in ${s}`,
        intro: (s) => `The three commands that explain 90% of ${s} crash loops: previous logs, events, and the exact exit code.`,
        params: () => [["Signal", "Meaning"], ["exit 137", "OOMKilled — raise limits or fix a leak"], ["exit 1", "app error — read the previous logs"], ["exit 143", "SIGTERM — check probes and shutdown handling"]],
        code: (s) => ["bash", `kubectl logs deploy/${s} -n prod --previous --tail=100\nkubectl describe pod -n prod -l app=${s} | sed -n '/Events:/,$p'\nkubectl get pod -n prod -l app=${s} \\\n  -o jsonpath='{.items[*].status.containerStatuses[*].lastState.terminated.exitCode}'`],
        verify: (s) => `kubectl get pods -n prod -l app=${s} — all Running, restarts stable`,
      },
      {
        title: (s) => `Autoscale ${s} on CPU and latency`,
        intro: (s) => `An HPA for ${s} that scales on CPU but never flaps: a stabilization window on the way down.`,
        params: () => [["Parameter", "Value"], ["minReplicas", "3"], ["maxReplicas", "12"], ["target CPU", "70%"]],
        code: (s) => ["yaml", `apiVersion: autoscaling/v2\nkind: HorizontalPodAutoscaler\nmetadata:\n  name: ${s}\n  namespace: prod\nspec:\n  scaleTargetRef:\n    apiVersion: apps/v1\n    kind: Deployment\n    name: ${s}\n  minReplicas: 3\n  maxReplicas: 12\n  behavior:\n    scaleDown:\n      stabilizationWindowSeconds: 300\n  metrics:\n    - type: Resource\n      resource:\n        name: cpu\n        target: { type: Utilization, averageUtilization: 70 }`],
        verify: (s) => `kubectl get hpa ${s} -n prod --watch`,
      },
      {
        title: (s) => `Roll back ${s} in under a minute`,
        intro: (s) => `When the new release of ${s} is bad, the fastest safe exit is the previous ReplicaSet — not a rebuild.`,
        params: () => [["Step", "Budget"], ["identify bad revision", "20s"], ["undo", "10s"], ["verify", "30s"]],
        code: (s) => ["bash", `kubectl rollout history deploy/${s} -n prod\nkubectl rollout undo deploy/${s} -n prod\nkubectl rollout status deploy/${s} -n prod --timeout=60s`],
        verify: (s) => `error rate for ${s} back to baseline on the dashboard`,
      },
      {
        title: (s) => `Lock down ${s} with a NetworkPolicy`,
        intro: (s) => `Default-deny for ${s}, then allow exactly the ingress it needs. Everything else stops at the CNI.`,
        params: (s) => [["Direction", "Allowed"], ["ingress", `gateway → ${s}:8080`], ["egress", "DNS + postgres only"]],
        code: (s) => ["yaml", `apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: ${s}-allow\n  namespace: prod\nspec:\n  podSelector:\n    matchLabels: { app: ${s} }\n  policyTypes: [Ingress]\n  ingress:\n    - from:\n        - podSelector:\n            matchLabels: { app: gateway }\n      ports:\n        - port: 8080`],
        verify: (s) => `kubectl exec a debug pod and confirm ${s}:8080 is unreachable except from the gateway`,
      },
    ],
  },
  {
    slug: "ops-airflow",
    name: "Ops: Airflow",
    desc: "Twenty-five recipes for authoring, triggering, and repairing Airflow DAGs.",
    subjects: PIPELINES,
    tasks: [
      {
        title: (s) => `Author the ${s} DAG`,
        intro: (s) => `The ${s} pipeline as a minimal, idempotent DAG: explicit schedule, no surprise catchup, retries with backoff.`,
        params: () => [["Parameter", "Value"], ["schedule", "0 3 * * *"], ["catchup", "False"], ["retries", "2, exponential backoff"]],
        code: (s) => ["python", `from airflow.decorators import dag, task\nfrom datetime import datetime, timedelta\n\n@dag(\n    dag_id="${s}",\n    schedule="0 3 * * *",\n    start_date=datetime(2026, 1, 1),\n    catchup=False,\n    default_args={"retries": 2, "retry_exponential_backoff": True,\n                  "retry_delay": timedelta(minutes=2)},\n)\ndef ${s.replace(/-/g, "_")}():\n    @task\n    def extract() -> str: ...\n    @task\n    def transform(batch: str) -> str: ...\n    @task\n    def load(batch: str) -> None: ...\n    load(transform(extract()))\n\n${s.replace(/-/g, "_")}()`],
        verify: (s) => `airflow dags list | grep ${s} && airflow dags test ${s}`,
      },
      {
        title: (s) => `Trigger ${s} with runtime config`,
        intro: (s) => `Fire ${s} on demand through the REST API with a conf payload the tasks read at runtime — the pattern a docs play button uses.`,
        params: () => [["Field", "Value"], ["endpoint", "POST /api/v2/dags/{dag_id}/dagRuns"], ["auth", "bearer token"], ["conf", "arbitrary JSON"]],
        code: (s) => ["bash", `curl -s -X POST "$AIRFLOW_URL/api/v2/dags/${s}/dagRuns" \\\n  -H "Authorization: Bearer $TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -d '{"conf": {"since": "2026-08-01", "dry_run": false}}'`],
        verify: (s) => `curl "$AIRFLOW_URL/api/v2/dags/${s}/dagRuns?order_by=-logical_date&limit=1" — state=success`,
      },
      {
        title: (s) => `Backfill ${s} safely`,
        intro: (s) => `Reprocess a date range of ${s} without stampeding the warehouse: bounded parallelism, marked as backfill.`,
        params: () => [["Flag", "Why"], ["--max-active-runs 2", "protect the warehouse"], ["--reset-dagruns", "rerun failed windows clean"]],
        code: (s) => ["bash", `airflow backfill create --dag-id ${s} \\\n  --from-date 2026-07-01 --to-date 2026-07-31 \\\n  --max-active-runs 2 --reset-dagruns`],
        verify: (s) => `airflow dags list-runs -d ${s} — July states all success`,
      },
      {
        title: (s) => `Alert when ${s} misses its SLA`,
        intro: (s) => `Freshness beats success: page when ${s} hasn't landed data by 05:00, even if nothing "failed".`,
        params: () => [["Parameter", "Value"], ["deadline", "05:00 UTC"], ["channel", "pagerduty via callback"]],
        code: (s) => ["python", `@task(\n    sla=timedelta(hours=2),\n    on_failure_callback=page_oncall,\n    on_sla_miss_callback=page_oncall,\n)\ndef load(batch: str) -> None:\n    ...`],
        verify: () => `hold one task with a sleep in staging and confirm the page fires`,
      },
      {
        title: (s) => `Pause, drain, and resume ${s}`,
        intro: (s) => `The maintenance-window dance for ${s}: stop new runs, let in-flight tasks finish, resume clean.`,
        params: () => [["Step", "Command"], ["pause", "airflow dags pause"], ["watch", "list-runs until none active"], ["resume", "airflow dags unpause"]],
        code: (s) => ["bash", `airflow dags pause ${s}\nwatch -n 30 'airflow dags list-runs -d ${s} --state running'\n# ...maintenance...\nairflow dags unpause ${s}`],
        verify: (s) => `next scheduled run of ${s} appears and succeeds`,
      },
    ],
  },
  {
    slug: "ops-ray",
    name: "Ops: Ray",
    desc: "Twenty-five recipes for distributed Python on Ray — jobs, serving, scaling, and debugging.",
    subjects: MODELS,
    tasks: [
      {
        title: (s) => `Submit the ${s} batch job`,
        intro: (s) => `Run ${s} as a Ray job with a pinned runtime env, submitted against the cluster's job API.`,
        params: () => [["Field", "Value"], ["entrypoint", "python run.py"], ["runtime_env", "pinned pip deps"], ["address", "ray://head:10001"]],
        code: (s) => ["bash", `ray job submit \\\n  --address http://ray-head:8265 \\\n  --runtime-env-json '{"pip": ["torch==2.6.0", "numpy<3"], "working_dir": "."}' \\\n  -- python jobs/${s}.py --batch-size 512`],
        verify: () => `ray job list — status SUCCEEDED, then ray job logs <id> for throughput`,
      },
      {
        title: (s) => `Serve ${s} with autoscaling replicas`,
        intro: (s) => `${s} behind Ray Serve: fractional GPUs, target ongoing requests, scale to zero off-hours.`,
        params: () => [["Parameter", "Value"], ["num_gpus", "0.5"], ["min_replicas", "0"], ["max_replicas", "8"]],
        code: (s) => ["python", `from ray import serve\n\n@serve.deployment(\n    ray_actor_options={"num_gpus": 0.5},\n    autoscaling_config={"min_replicas": 0, "max_replicas": 8,\n                        "target_ongoing_requests": 4},\n)\nclass ${s.split("-").map(w => w[0].toUpperCase() + w.slice(1)).join("")}:\n    def __call__(self, request) -> dict:\n        ...\n\napp = ${s.split("-").map(w => w[0].toUpperCase() + w.slice(1)).join("")}.bind()`],
        verify: (s) => `serve status — ${s} HEALTHY; hammer it and watch replicas grow`,
      },
      {
        title: (s) => `Debug a dead actor in ${s}`,
        intro: (s) => `When ${s} actors die silently, the state API and per-actor logs tell you which node and why.`,
        params: () => [["Signal", "Meaning"], ["OUT_OF_MEMORY", "object store pressure — spill or shrink batches"], ["NODE_DIED", "spot preemption — add tolerations"]],
        code: () => ["bash", `ray list actors --detail --filter "state=DEAD" | head -40\nray logs actor --id <ACTOR_ID> --tail 200`],
        verify: () => `ray list actors --filter "state=ALIVE" matches expected parallelism`,
      },
      {
        title: (s) => `Tune ${s} hyperparameters on the cluster`,
        intro: (s) => `A Ray Tune sweep for ${s} with ASHA early stopping — burn less GPU on losers.`,
        params: () => [["Parameter", "Value"], ["num_samples", "64"], ["scheduler", "ASHA"], ["metric", "val_loss"]],
        code: (s) => ["python", `from ray import tune\nfrom ray.tune.schedulers import ASHAScheduler\n\ntuner = tune.Tuner(\n    train_${s.replace(/-/g, "_")},\n    param_space={"lr": tune.loguniform(1e-5, 1e-2),\n                 "batch": tune.choice([64, 128, 256])},\n    tune_config=tune.TuneConfig(\n        num_samples=64,\n        scheduler=ASHAScheduler(metric="val_loss", mode="min"),\n    ),\n)\nresults = tuner.fit()\nprint(results.get_best_result().config)`],
        verify: () => `best trial's val_loss beats the incumbent before promoting`,
      },
      {
        title: (s) => `Right-size the object store for ${s}`,
        intro: (s) => `${s} spilling to disk is a silent 10x slowdown. Size the object store and watch spill counters.`,
        params: () => [["Parameter", "Value"], ["object-store-memory", "30% of node RAM"], ["spill dir", "local NVMe only"]],
        code: () => ["bash", `ray start --head \\\n  --object-store-memory=$((30 * 1024 * 1024 * 1024)) \\\n  --system-config='{"object_spilling_threshold": 0.85}'\nray memory --stats-only   # watch "Spilled" stay at 0`],
        verify: () => `ray memory --stats-only shows zero spilled bytes under production load`,
      },
    ],
  },
  {
    slug: "ops-jenkins",
    name: "Ops: Jenkins",
    desc: "Twenty-five recipes for Jenkins pipelines — declarative builds, remote triggers, credentials, and gates.",
    subjects: JOBS,
    tasks: [
      {
        title: (s) => `Declarative Jenkinsfile for ${s}`,
        intro: (s) => `The ${s} pipeline as code: timeouts so nothing hangs forever, artifacts on success, cleanup always.`,
        params: () => [["Parameter", "Value"], ["agent", "linux label"], ["timeout", "30 min"], ["retention", "last 20 builds"]],
        code: (s) => ["groovy", `pipeline {\n  agent { label 'linux' }\n  options {\n    timeout(time: 30, unit: 'MINUTES')\n    buildDiscarder(logRotator(numToKeepStr: '20'))\n  }\n  stages {\n    stage('Build') { steps { sh 'make ${s}' } }\n    stage('Test')  { steps { sh 'make test' } }\n  }\n  post {\n    success { archiveArtifacts artifacts: 'dist/**' }\n    always  { cleanWs() }\n  }\n}`],
        verify: (s) => `first run of ${s} green in the classic UI and Blue Ocean`,
      },
      {
        title: (s) => `Trigger ${s} remotely with parameters`,
        intro: (s) => `Kick ${s} from anywhere over the REST API with a crumb and parameters — the shape a docs play button calls.`,
        params: () => [["Field", "Value"], ["endpoint", "POST /job/{name}/buildWithParameters"], ["auth", "user API token"], ["CSRF", "crumb header"]],
        code: (s) => ["bash", `CRUMB=$(curl -s -u "$USER:$TOKEN" "$JENKINS_URL/crumbIssuer/api/json" | jq -r .crumb)\ncurl -s -X POST -u "$USER:$TOKEN" -H "Jenkins-Crumb: $CRUMB" \\\n  "$JENKINS_URL/job/${s}/buildWithParameters" \\\n  --data-urlencode GIT_REF=main --data-urlencode DEPLOY_ENV=staging`],
        verify: (s) => `GET /job/${s}/lastBuild/api/json — result SUCCESS`,
      },
      {
        title: (s) => `Wire secrets into ${s} without leaking them`,
        intro: (s) => `Credentials binding for ${s}: secrets exist only inside the block, masked in the log.`,
        params: () => [["Credential", "Kind"], ["registry-push", "username/password"], ["deploy-key", "SSH private key"]],
        code: () => ["groovy", `withCredentials([\n  usernamePassword(credentialsId: 'registry-push',\n                   usernameVariable: 'REG_USER',\n                   passwordVariable: 'REG_PASS'),\n]) {\n  sh 'echo "$REG_PASS" | docker login ghcr.io -u "$REG_USER" --password-stdin'\n  sh 'docker push ghcr.io/acme/app:$BUILD_NUMBER'\n}`],
        verify: () => `console log shows **** where the secret would be`,
      },
      {
        title: (s) => `Parallelize the slow stages of ${s}`,
        intro: (s) => `${s} spends most of its wall clock in tests. Split them into parallel stages with failFast.`,
        params: () => [["Stage", "Typical time"], ["unit", "4 min"], ["integration", "9 min"], ["lint", "1 min"]],
        code: () => ["groovy", `stage('Verify') {\n  failFast true\n  parallel {\n    stage('Unit')        { steps { sh 'make test-unit' } }\n    stage('Integration') { steps { sh 'make test-integration' } }\n    stage('Lint')        { steps { sh 'make lint' } }\n  }\n}`],
        verify: (s) => `${s} wall clock drops to the slowest branch, not the sum`,
      },
      {
        title: (s) => `Gate ${s} production deploys on approval`,
        intro: (s) => `A human gate between staging and production for ${s}, with a timeout that fails closed.`,
        params: () => [["Parameter", "Value"], ["approvers", "release-managers"], ["timeout", "4 hours, then abort"]],
        code: () => ["groovy", `stage('Approve production') {\n  steps {\n    timeout(time: 4, unit: 'HOURS') {\n      input message: 'Ship to production?',\n            submitter: 'release-managers'\n    }\n  }\n}`],
        verify: () => `non-approver cannot click Proceed; timeout aborts the run`,
      },
    ],
  },
  {
    slug: "ops-openshift-pipelines",
    name: "Ops: OpenShift Pipelines",
    desc: "Twenty-five Tekton recipes for OpenShift Pipelines — pipelines, runs, workspaces, and triggers.",
    subjects: SERVICES,
    tasks: [
      {
        title: (s) => `Build and push ${s} with a Pipeline`,
        intro: (s) => `A two-task Tekton pipeline for ${s}: clone with the cluster git-clone task, build with buildah.`,
        params: (s) => [["Param", "Value"], ["git-url", `https://github.com/acme/${s}`], ["image", `image-registry.openshift-image-registry.svc:5000/prod/${s}`]],
        code: (s) => ["yaml", `apiVersion: tekton.dev/v1\nkind: Pipeline\nmetadata:\n  name: ${s}-build\nspec:\n  params:\n    - name: git-url\n    - name: image\n  workspaces:\n    - name: source\n  tasks:\n    - name: clone\n      taskRef: { name: git-clone, kind: ClusterTask }\n      params:\n        - { name: url, value: $(params.git-url) }\n      workspaces: [{ name: output, workspace: source }]\n    - name: build\n      runAfter: [clone]\n      taskRef: { name: buildah, kind: ClusterTask }\n      params:\n        - { name: IMAGE, value: $(params.image) }\n      workspaces: [{ name: source, workspace: source }]`],
        verify: (s) => `tkn pipeline start ${s}-build ... && tkn pipelinerun logs -f — both tasks green`,
      },
      {
        title: (s) => `Run the ${s} pipeline on demand`,
        intro: (s) => `A PipelineRun for ${s} with an ephemeral workspace — the object a docs play button creates.`,
        params: () => [["Field", "Value"], ["workspace", "1Gi ephemeral PVC"], ["serviceAccount", "pipeline"]],
        code: (s) => ["yaml", `apiVersion: tekton.dev/v1\nkind: PipelineRun\nmetadata:\n  generateName: ${s}-build-\nspec:\n  pipelineRef: { name: ${s}-build }\n  params:\n    - { name: git-url, value: "https://github.com/acme/${s}" }\n    - { name: image, value: "…/prod/${s}:latest" }\n  workspaces:\n    - name: source\n      volumeClaimTemplate:\n        spec:\n          accessModes: [ReadWriteOnce]\n          resources: { requests: { storage: 1Gi } }`],
        verify: (s) => `oc get pipelinerun -l tekton.dev/pipeline=${s}-build — Succeeded`,
      },
      {
        title: (s) => `Trigger ${s} builds from git pushes`,
        intro: (s) => `An EventListener that turns a webhook push into a PipelineRun for ${s}.`,
        params: () => [["Object", "Role"], ["TriggerBinding", "extract revision from payload"], ["TriggerTemplate", "stamp out the PipelineRun"], ["EventListener", "receive the webhook"]],
        code: (s) => ["yaml", `apiVersion: triggers.tekton.dev/v1beta1\nkind: EventListener\nmetadata:\n  name: ${s}-push\nspec:\n  serviceAccountName: pipeline\n  triggers:\n    - name: on-push\n      bindings:\n        - { ref: ${s}-binding }\n      template:\n        ref: ${s}-template`],
        verify: (s) => `push a commit; oc get pipelinerun shows a fresh ${s} run`,
      },
      {
        title: (s) => `Cache dependencies between ${s} runs`,
        intro: (s) => `A persistent workspace so ${s} stops re-downloading the world every run.`,
        params: () => [["Parameter", "Value"], ["PVC", "5Gi, RWO"], ["cache key", "lockfile hash"]],
        code: (s) => ["yaml", `workspaces:\n  - name: cache\n    persistentVolumeClaim:\n      claimName: ${s}-dep-cache\n# in the build task:\n#   volumeMounts the workspace at /root/.cache`],
        verify: (s) => `second ${s} run's install step drops from minutes to seconds`,
      },
      {
        title: (s) => `Record results and surface them for ${s}`,
        intro: (s) => `Tekton results carry the built image digest out of the ${s} pipeline for downstream signing or docs.`,
        params: () => [["Result", "Content"], ["IMAGE_DIGEST", "sha256 of the pushed image"], ["COMMIT", "revision built"]],
        code: () => ["yaml", `results:\n  - name: IMAGE_DIGEST\n    description: digest of the pushed image\nsteps:\n  - name: report\n    image: registry.access.redhat.com/ubi9-minimal\n    script: |\n      cat /workspace/digestfile | tee $(results.IMAGE_DIGEST.path)`],
        verify: (s) => `tkn pipelinerun describe <run> shows the digest under Results`,
      },
    ],
  },
  {
    slug: "ops-jupyter",
    name: "Ops: Jupyter",
    desc: "Twenty-five recipes for notebooks as production artifacts — parameterized, executed headless, and published.",
    subjects: NOTEBOOKS,
    tasks: [
      {
        title: (s) => `Parameterize ${s} for headless runs`,
        intro: (s) => `Tag one cell "parameters" and ${s} becomes a function: papermill injects values at execution time.`,
        params: () => [["Parameter", "Default"], ["run_date", "today"], ["sample_frac", "1.0"], ["output_table", "analytics.results"]],
        code: (s) => ["python", `# cell tagged "parameters"\nrun_date = "2026-08-19"\nsample_frac = 1.0\noutput_table = "analytics.results"\n\n# downstream cells treat these as constants\ndf = load_events(run_date, sample_frac)`],
        verify: (s) => `papermill ${s}.ipynb /tmp/out.ipynb -p sample_frac 0.1 exits 0`,
      },
      {
        title: (s) => `Execute ${s} headless with papermill`,
        intro: (s) => `The production run of ${s}: executed top to bottom, failures loud, output notebook kept as the artifact.`,
        params: () => [["Flag", "Why"], ["--log-output", "stream cell output to CI logs"], ["-k python3", "pin the kernel"]],
        code: (s) => ["bash", `papermill notebooks/${s}.ipynb \\\n  artifacts/${s}-$(date +%F).ipynb \\\n  -p run_date $(date +%F) \\\n  -k python3 --log-output`],
        verify: (s) => `artifacts/${s}-*.ipynb exists and the exit code was 0`,
      },
      {
        title: (s) => `Publish ${s} as a static report`,
        intro: (s) => `Readers want the story of ${s}, not the code. nbconvert with inputs hidden makes the shareable report.`,
        params: () => [["Option", "Effect"], ["--no-input", "hide code cells"], ["--to html", "single self-contained file"]],
        code: (s) => ["bash", `jupyter nbconvert artifacts/${s}-2026-08-19.ipynb \\\n  --to html --no-input \\\n  --output reports/${s}.html`],
        verify: (s) => `reports/${s}.html opens with charts only — no code`,
      },
      {
        title: (s) => `Schedule ${s} nightly`,
        intro: (s) => `${s} on a timer: cron runs papermill, keeps the last 14 artifacts, pages on failure.`,
        params: () => [["Field", "Value"], ["schedule", "15 4 * * *"], ["retention", "14 days"]],
        code: (s) => ["bash", `# /etc/cron.d/${s}\n15 4 * * * analyst papermill /srv/nb/${s}.ipynb \\\n  /srv/artifacts/${s}-$(date +\\%F).ipynb -p run_date $(date +\\%F) \\\n  >> /var/log/${s}.log 2>&1 || notify-oncall "${s} failed"\n# retention\n0 5 * * * analyst find /srv/artifacts -name '${s}-*' -mtime +14 -delete`],
        verify: (s) => `two mornings of artifacts exist and the log shows clean runs`,
      },
      {
        title: (s) => `Test ${s} like code`,
        intro: (s) => `Notebooks rot silently. A smoke test executes ${s} on a sample and asserts the outputs it promises.`,
        params: () => [["Check", "Assertion"], ["executes", "exit code 0 on 1% sample"], ["contract", "output table schema unchanged"]],
        code: (s) => ["python", `import papermill as pm\n\ndef test_${s.replace(/-/g, "_")}_runs():\n    pm.execute_notebook(\n        "notebooks/${s}.ipynb", "/tmp/out.ipynb",\n        parameters={"sample_frac": 0.01},\n    )\n\ndef test_output_contract():\n    df = read_table("analytics.results")\n    assert {"run_date", "metric", "value"} <= set(df.columns)`],
        verify: () => `pytest -q tests/notebooks — green in CI on every PR`,
      },
    ],
  },
];

const basePos = (db.prepare("SELECT COALESCE(MAX(position),0) p FROM spaces").get()).p;
let total = 0;

PLATFORMS.forEach((platform, pi) => {
  if (db.prepare("SELECT 1 FROM spaces WHERE slug=?").get(platform.slug)) {
    console.log(`skip ${platform.slug} (exists)`);
    return;
  }
  const sid = id();
  db.prepare(
    `INSERT INTO spaces (id, slug, name, description, emoji, kind, visibility, accent, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', 'cookbook', 'public', 'vermilion', ?, ?, ?)`
  ).run(sid, platform.slug, platform.name, platform.desc, basePos + 1 + pi, now, now);

  const seen = new Set();
  let pos = 1;
  for (const subject of platform.subjects) {
    for (const task of platform.tasks) {
      const title = task.title(subject);
      const [lang, src] = task.code(subject);
      const blocks = [
        P(T(task.intro(subject))),
        H(2, "Parameters"),
        TABLE(task.params(subject)),
        H(2, "Run"),
        CODE(lang, src),
        H(2, "Verify"),
        P(T(task.verify(subject))),
      ];
      let slug = slugify(title);
      let i = 2;
      while (seen.has(slug)) slug = `${slugify(title)}-${i++}`;
      seen.add(slug);
      const content = JSON.stringify(blocks);
      const body = textOf(blocks);
      const pid = id();
      db.prepare(
        `INSERT INTO pages (id, space_id, parent_id, slug, title, content, content_text, position, published, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 1, ?, ?)`
      ).run(pid, sid, slug, title, content, body, pos++, now, now);
      db.prepare("INSERT INTO pages_fts (page_id, title, body) VALUES (?, ?, ?)").run(pid, title, body);
      total++;
    }
  }
  console.log(`${platform.name}: 25 recipes`);
});

console.log(`Code corpus seeded: ${total} documents`);
