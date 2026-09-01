import "server-only";
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DATA_DIR, UPLOADS_DIR, getDb } from "./db";
import { renewLease } from "./failover";
import { getSetting } from "./settings";
import { now } from "./util";

/**
 * Replication: a consistent snapshot of the database, shipped to
 * S3-compatible object storage on a cadence.
 *
 * Deliberately a snapshot stream rather than a WAL tail. A WAL tail gives a
 * smaller recovery point and a much larger set of ways to be subtly wrong —
 * frame accounting, checkpoint races, a restore that needs the right
 * sequence of segments replayed in order. A snapshot made with SQLite's own
 * backup API is consistent by construction, restores by copying one file,
 * and its verification is "open it and read". For the deployments Octavo
 * targets — one writer, one file — a snapshot every few minutes is an honest
 * RPO, stated as such.
 *
 * Zero dependencies: SigV4 is ~40 lines of HMAC, and depending on an AWS SDK
 * to avoid writing them would be the wrong trade for this codebase. Works
 * against AWS, MinIO, and R2; an air-gapped MinIO on the same network is the
 * expected disconnected arrangement.
 *
 * Uploads are named octavo-YYYYMMDDTHHMMSS.db plus a rolling octavo-latest.db,
 * so restore-the-newest never requires a listing.
 */

export type ReplicaTarget = {
  endpoint: string; // https://s3.us-east-1.amazonaws.com or http://minio:9000
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  prefix: string;
  intervalMinutes: number;
  /** Snapshots older than this are deleted from the bucket on each ship. */
  keepDays: number;
};

export function replicaTarget(): ReplicaTarget | null {
  const raw = getSetting("replica_target");
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as Partial<ReplicaTarget>;
    if (!t.endpoint || !t.bucket || !t.accessKey || !t.secretKey) return null;
    return {
      endpoint: String(t.endpoint).replace(/\/$/, ""),
      region: t.region || "us-east-1",
      bucket: String(t.bucket),
      accessKey: String(t.accessKey),
      secretKey: String(t.secretKey),
      prefix: (t.prefix || "octavo").replace(/^\/|\/$/g, ""),
      intervalMinutes: Math.max(1, Number(t.intervalMinutes) || 5),
      keepDays: Math.max(1, Number(t.keepDays) || 14),
    };
  } catch {
    return null;
  }
}

// ---- SigV4, the forty lines ----

const sha256hex = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) =>
  createHmac("sha256", key).update(data).digest();

export function sigv4Headers(
  t: ReplicaTarget,
  method: string,
  key: string,
  body: Buffer,
  /** Injectable for the known-answer test; production always uses now. */
  dateOverride?: string
): Record<string, string> {
  const url = new URL(`${t.endpoint}/${t.bucket}/${key}`);
  const amzDate =
    dateOverride ??
    new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);

  const canonicalHeaders =
    `host:${url.host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    method,
    url.pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${date}/${t.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac("AWS4" + t.secretKey, date);
  const kRegion = hmac(kDate, t.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning)
    .update(stringToSign)
    .digest("hex");

  return {
    Host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${t.accessKey}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** A signed request against any S3-compatible endpoint. Shared with the
 *  replica side, which pulls what this module ships. */
export async function sigv4Fetch(
  t: ReplicaTarget,
  method: string,
  key: string,
  body: Buffer = Buffer.alloc(0)
): Promise<Response> {
  return s3Request(t, method, key, body);
}

async function s3Request(
  t: ReplicaTarget,
  method: string,
  key: string,
  body: Buffer = Buffer.alloc(0)
): Promise<Response> {
  const headers = sigv4Headers(t, method, key, body);
  return fetch(`${t.endpoint}/${t.bucket}/${key}`, {
    method,
    headers,
    body: method === "PUT" ? new Uint8Array(body) : undefined,
  });
}

// ---- uploads ----

/**
 * Shipping the uploads directory beside the database.
 *
 * A snapshot without the uploads is a restore that comes back with every
 * image, attachment and diagram missing — technically a recovery, and
 * useless. Files are content-addressed by name and never rewritten, so this
 * only ever needs to ship what is new: a manifest of what has already gone
 * means a nightly run costs one small listing rather than the whole library.
 */
export type UploadShipResult = {
  ok: boolean;
  sent: number;
  skipped: number;
  bytes: number;
  error?: string;
};

function uploadManifestPath(): string {
  return path.join(DATA_DIR, ".replicated-uploads.json");
}

function readUploadManifest(): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(uploadManifestPath(), "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

function writeUploadManifest(m: Record<string, number>): void {
  try {
    fs.writeFileSync(uploadManifestPath(), JSON.stringify(m));
  } catch {
    // A manifest that cannot be written costs re-uploads, not correctness.
  }
}

export async function shipUploads(): Promise<UploadShipResult> {
  const t = replicaTarget();
  if (!t) return { ok: false, sent: 0, skipped: 0, bytes: 0, error: "no target configured" };
  if (!fs.existsSync(UPLOADS_DIR)) return { ok: true, sent: 0, skipped: 0, bytes: 0 };

  const manifest = readUploadManifest();
  let sent = 0, skipped = 0, bytes = 0;
  for (const name of fs.readdirSync(UPLOADS_DIR)) {
    if (name.startsWith(".")) continue;
    const full = path.join(UPLOADS_DIR, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    // Size is the whole test: these names are generated per upload and the
    // file behind one never changes. A hash would cost a full read of every
    // file on every run to learn the same thing.
    if (manifest[name] === stat.size) { skipped++; continue; }
    const body = fs.readFileSync(full);
    const put = await s3Request(t, "PUT", `${t.prefix}/uploads/${name}`, body);
    if (!put.ok)
      return { ok: false, sent, skipped, bytes, error: `${name}: HTTP ${put.status}` };
    manifest[name] = stat.size;
    sent++;
    bytes += body.length;
  }
  writeUploadManifest(manifest);

  // Ship the manifest too. A replica could list the bucket instead, but
  // listing needs a signed query string, and one small object it can GET by
  // name says exactly the same thing with none of that machinery.
  const list = Buffer.from(JSON.stringify(Object.keys(manifest)), "utf8");
  const put = await s3Request(t, "PUT", `${t.prefix}/uploads-manifest.json`, list);
  if (!put.ok)
    return { ok: false, sent, skipped, bytes, error: `manifest: HTTP ${put.status}` };

  return { ok: true, sent, skipped, bytes };
}

// ---- the ship itself ----

export type ShipResult = {
  ok: boolean;
  key?: string;
  bytes?: number;
  verified?: boolean;
  error?: string;
  at: number;
  uploads?: { sent: number; skipped: number };
  /** Set when the database shipped but its files did not — a partial backup. */
  uploadsError?: string;
};

let lastShip: ShipResult | null = null;
export function lastShipResult(): ShipResult | null {
  return lastShip;
}

/**
 * Snapshot, verify, upload. The verification opens the snapshot with a fresh
 * SQLite handle and counts pages — a backup that cannot be opened and read is
 * not a backup, and finding that out at restore time is the disaster this
 * whole module exists to prevent.
 */
export async function shipSnapshot(): Promise<ShipResult> {
  const t = replicaTarget();
  if (!t) return { ok: false, error: "no target configured", at: now() };

  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "");
  const tmp = path.join(DATA_DIR, `.snapshot-${process.pid}.db`);

  try {
    await getDb().backup(tmp);

    // Verify before shipping: open it, walk it, count something real.
    let verified = false;
    try {
      const check = new Database(tmp, { readonly: true });
      const integrity = check.pragma("integrity_check", { simple: true });
      const pages = (
        check.prepare("SELECT COUNT(*) AS c FROM pages").get() as { c: number }
      ).c;
      check.close();
      verified = integrity === "ok" && pages >= 0;
    } catch {
      verified = false;
    }
    if (!verified) {
      return (lastShip = { ok: false, error: "snapshot failed verification", at: now() });
    }

    const body = fs.readFileSync(tmp);
    const key = `${t.prefix}/octavo-${stamp}.db`;
    const put = await s3Request(t, "PUT", key, body);
    if (!put.ok)
      return (lastShip = {
        ok: false,
        error: `upload failed: HTTP ${put.status}`,
        at: now(),
      });

    // The rolling head. Restore is "fetch this one key".
    const head = await s3Request(t, "PUT", `${t.prefix}/octavo-latest.db`, body);
    if (!head.ok)
      return (lastShip = {
        ok: false,
        error: `latest upload failed: HTTP ${head.status}`,
        at: now(),
      });

    // The lease says "backups are still being produced by this node", which
    // is the only claim a standby should ever act on.
    void renewLease();

    // Uploads travel with the database. A restore that comes back without
    // them is a library of broken images.
    const files = await shipUploads();

    return (lastShip = {
      ok: true,
      key,
      bytes: body.length,
      verified,
      at: now(),
      uploads: files.ok ? { sent: files.sent, skipped: files.skipped } : undefined,
      uploadsError: files.ok ? undefined : files.error,
    });
  } catch (err) {
    return (lastShip = {
      ok: false,
      error: err instanceof Error ? err.message : "ship failed",
      at: now(),
    });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start (or restart) the cadence. Called at boot and when settings change. */
export function scheduleReplication(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const t = replicaTarget();
  if (!t) return;
  timer = setInterval(() => {
    void shipSnapshot();
  }, t.intervalMinutes * 60_000);
  // Unref so a shutdown does not wait on us.
  timer.unref?.();
}
