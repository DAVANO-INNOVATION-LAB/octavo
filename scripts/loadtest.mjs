// Octavo load test — hammers key endpoints, reports throughput + latency.
// Usage: node scripts/loadtest.mjs [baseUrl] [label]
//   e.g. node scripts/loadtest.mjs http://localhost:8524 baseline
import { writeFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:8524";
const LABEL = process.argv[3] ?? "run";
const CONCURRENCY = 20;
const DURATION_MS = 10_000;

const TARGETS = [
  { name: "home (library grid)", path: "/" },
  { name: "space cover (30-page TOC)", path: "/rfc-reading-room" },
  { name: "reader page (RFC, code blocks)", path: "/rfc-reading-room/rfc-9293-transmission-control-protocol-tcp" },
  { name: "reader page (shiki + mermaid)", path: "/field-guide/code" },
  { name: "search (FTS5)", path: "/api/search?q=transmission%20control" },
  { name: "search (broad)", path: "/api/search?q=learning" },
];

function pct(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function run(target) {
  const latencies = [];
  let errors = 0;
  let bytes = 0;
  const stop = Date.now() + DURATION_MS;

  async function worker() {
    while (Date.now() < stop) {
      const t0 = performance.now();
      try {
        const res = await fetch(BASE + target.path, { redirect: "manual" });
        const body = await res.arrayBuffer();
        bytes += body.byteLength;
        if (res.status >= 400) errors++;
        latencies.push(performance.now() - t0);
      } catch {
        errors++;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const sorted = latencies.slice().sort((a, b) => a - b);
  const secs = DURATION_MS / 1000;
  return {
    name: target.name,
    path: target.path,
    requests: latencies.length,
    rps: +(latencies.length / secs).toFixed(1),
    p50_ms: +pct(sorted, 50).toFixed(1),
    p95_ms: +pct(sorted, 95).toFixed(1),
    p99_ms: +pct(sorted, 99).toFixed(1),
    errors,
    mb_per_s: +(bytes / 1e6 / secs).toFixed(1),
  };
}

console.log(`Load test against ${BASE} — ${CONCURRENCY} concurrent, ${DURATION_MS / 1000}s per target\n`);
// Warm each route first (build caches, JIT).
for (const t of TARGETS) await fetch(BASE + t.path).catch(() => {});

const results = [];
for (const t of TARGETS) {
  const r = await run(t);
  results.push(r);
  console.log(
    `${r.name.padEnd(34)} ${String(r.rps).padStart(7)} req/s   p50 ${String(r.p50_ms).padStart(7)}ms   p95 ${String(r.p95_ms).padStart(7)}ms   p99 ${String(r.p99_ms).padStart(8)}ms   errors ${r.errors}`
  );
}

const out = { label: LABEL, base: BASE, at: new Date().toISOString(), concurrency: CONCURRENCY, duration_ms: DURATION_MS, results };
writeFileSync(`loadtest-${LABEL}.json`, JSON.stringify(out, null, 2));
console.log(`\nsaved loadtest-${LABEL}.json`);
