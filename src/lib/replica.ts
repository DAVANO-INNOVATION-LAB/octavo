import "server-only";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DATA_DIR, isReplica, swapDb } from "./db";

/**
 * The reading half of replication: a process that follows the snapshots the
 * primary ships and serves the library from them, read-only.
 *
 * Together with lib/replicate this is the deliberately modest answer to high
 * availability and read scale-out:
 *
 *   warm standby   run one replica; promotion is restarting it without
 *                  OCTAVO_REPLICA=1, at which point it owns the newest
 *                  snapshot it had and starts shipping its own
 *   read scale-out any number of replicas behind a load balancer, each
 *                  pulling on its own cadence
 *
 * One writer, always. SQLite has a single writer and pretending otherwise is
 * how systems get quietly corrupted; a replica cannot write even by bug,
 * because the connection itself is opened query_only.
 *
 * Configuration is environment-only. A replica's database is replaced from
 * outside on a timer — settings stored inside it would be overwritten on
 * every pull, so the environment is the only honest place:
 *
 *   OCTAVO_REPLICA=1
 *   OCTAVO_REPLICA_ENDPOINT=https://minio.internal:9000
 *   OCTAVO_REPLICA_BUCKET=backups
 *   OCTAVO_REPLICA_ACCESS_KEY=…    OCTAVO_REPLICA_SECRET_KEY=…
 *   OCTAVO_REPLICA_REGION=us-east-1 (default)
 *   OCTAVO_REPLICA_PREFIX=octavo    (default)
 *   OCTAVO_REPLICA_INTERVAL=60     seconds between pulls (default)
 */

import { sigv4Fetch } from "./replicate";

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export type PullResult = {
  ok: boolean;
  bytes?: number;
  changed?: boolean;
  error?: string;
  at: number;
};

let lastPull: PullResult | null = null;
export function lastPullResult(): PullResult | null {
  return lastPull;
}

let lastEtag = "";

export async function pullSnapshot(): Promise<PullResult> {
  const endpoint = env("OCTAVO_REPLICA_ENDPOINT").replace(/\/$/, "");
  const bucket = env("OCTAVO_REPLICA_BUCKET");
  if (!endpoint || !bucket)
    return { ok: false, error: "replica source not configured", at: Date.now() };

  const target = {
    endpoint,
    region: env("OCTAVO_REPLICA_REGION", "us-east-1"),
    bucket,
    accessKey: env("OCTAVO_REPLICA_ACCESS_KEY"),
    secretKey: env("OCTAVO_REPLICA_SECRET_KEY"),
    prefix: env("OCTAVO_REPLICA_PREFIX", "octavo").replace(/^\/|\/$/g, ""),
    intervalMinutes: 1,
    keepDays: 1,
  };

  try {
    const res = await sigv4Fetch(target, "GET", `${target.prefix}/octavo-latest.db`);
    if (!res.ok)
      return (lastPull = { ok: false, error: `HTTP ${res.status}`, at: Date.now() });

    // Unchanged content is the common case; do not churn the handle for it.
    const etag = res.headers.get("etag") ?? "";
    if (etag && etag === lastEtag)
      return (lastPull = { ok: true, changed: false, at: Date.now() });

    const body = Buffer.from(await res.arrayBuffer());
    const incoming = path.join(DATA_DIR, `.incoming-${process.pid}.db`);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(incoming, body);

    // Same rule as the shipper: never serve what has not been opened and read.
    try {
      const check = new Database(incoming, { readonly: true });
      const integrity = check.pragma("integrity_check", { simple: true });
      check.prepare("SELECT COUNT(*) FROM pages").get();
      check.close();
      if (integrity !== "ok") throw new Error("integrity check failed");
    } catch (e) {
      fs.rmSync(incoming, { force: true });
      return (lastPull = {
        ok: false,
        error: e instanceof Error ? e.message : "verification failed",
        at: Date.now(),
      });
    }

    swapDb(incoming);
    lastEtag = etag;
    return (lastPull = { ok: true, changed: true, bytes: body.length, at: Date.now() });
  } catch (err) {
    return (lastPull = {
      ok: false,
      error: err instanceof Error ? err.message : "pull failed",
      at: Date.now(),
    });
  }
}

export function scheduleReplicaPull(): void {
  if (!isReplica()) return;
  const seconds = Math.max(10, Number(env("OCTAVO_REPLICA_INTERVAL", "60")) || 60);
  void pullSnapshot();
  const timer = setInterval(() => {
    void pullSnapshot();
  }, seconds * 1000);
  timer.unref?.();
}
