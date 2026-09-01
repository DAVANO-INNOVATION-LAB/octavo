import "server-only";
import { now } from "./util";
import { isReplica } from "./db";
import { replicaTarget, sigv4Fetch, type ReplicaTarget } from "./replicate";

/**
 * Automated failover, without two writers.
 *
 * Promotion has always been possible: restart the standby without
 * OCTAVO_REPLICA=1 and it owns the newest snapshot it holds. Automating that
 * is where systems get themselves into trouble, because the obvious version —
 * "the primary stopped answering, so I am the primary now" — produces two
 * writers the moment the old one comes back or was merely unreachable. One
 * writer is the promise SQLite is built on, and losing it silently corrupts.
 *
 * So the decision is not made by either node. The bucket both already depend
 * on holds a lease: the primary renews it on every ship, and a standby may
 * promote only when that lease is demonstrably stale AND it can take the
 * lease itself. The store everyone can already see is the arbiter, so there
 * is no split brain to resolve — a node that cannot take the lease does not
 * promote, and says why.
 *
 * This deliberately stops one step short of restarting the process: it
 * declares readiness and takes the lease. Whatever supervises the container —
 * Kubernetes, a unit file, a person — performs the restart, because that is
 * the thing that already knows how to start Octavo correctly.
 */

export type LeaseState = {
  /** Who currently holds it. */
  holder: string;
  /** When they last renewed, in epoch milliseconds. */
  renewed: number;
};

export type FailoverStatus = {
  /** This node's identity in the lease. */
  id: string;
  role: "primary" | "standby";
  lease: LeaseState | null;
  /** Seconds since the lease was last renewed by anyone. */
  staleFor: number | null;
  /** True when this standby has taken the lease and should be restarted. */
  promotable: boolean;
  reason: string;
  at: number;
};

const LEASE_KEY = (t: ReplicaTarget) => `${t.prefix}/lease.json`;

/** How long a lease may go unrenewed before a standby may take it. */
function staleSeconds(): number {
  const v = Number(process.env.OCTAVO_LEASE_STALE_SECONDS ?? "180");
  // Never below a minute: a slow ship on a big library is not an outage, and
  // promoting because a snapshot took ninety seconds is the failure mode this
  // whole mechanism exists to avoid.
  return Number.isFinite(v) && v >= 60 ? v : 180;
}

export function nodeId(): string {
  return (
    process.env.OCTAVO_NODE_ID ||
    process.env.HOSTNAME ||
    `node-${process.pid}`
  );
}

async function readLease(t: ReplicaTarget): Promise<LeaseState | null> {
  const res = await sigv4Fetch(t, "GET", LEASE_KEY(t));
  if (!res.ok) return null;
  try {
    const raw = JSON.parse(await res.text()) as Partial<LeaseState>;
    if (typeof raw.holder !== "string" || typeof raw.renewed !== "number") return null;
    return { holder: raw.holder, renewed: raw.renewed };
  } catch {
    return null;
  }
}

async function writeLease(t: ReplicaTarget, state: LeaseState): Promise<boolean> {
  const res = await sigv4Fetch(
    t, "PUT", LEASE_KEY(t), Buffer.from(JSON.stringify(state), "utf8")
  );
  return res.ok;
}

/**
 * Called by the primary every time it ships. Renewing here rather than on its
 * own timer means the lease tracks the thing that actually matters — that
 * backups are still being produced — instead of merely that a process is up.
 */
export async function renewLease(): Promise<boolean> {
  const t = replicaTarget();
  if (!t || isReplica()) return false;
  return writeLease(t, { holder: nodeId(), renewed: now() });
}

let last: FailoverStatus | null = null;
export function lastFailoverStatus(): FailoverStatus | null {
  return last;
}

/**
 * A standby's health check. Returns what it sees and, when the lease has
 * genuinely lapsed, takes it — so exactly one standby ends up promotable
 * even if several are watching.
 */
export async function checkFailover(): Promise<FailoverStatus> {
  const id = nodeId();
  const base: FailoverStatus = {
    id,
    role: isReplica() ? "standby" : "primary",
    lease: null,
    staleFor: null,
    promotable: false,
    reason: "",
    at: now(),
  };

  const t = replicaTarget();
  if (!t) return (last = { ...base, reason: "no shared store is configured" });
  if (!isReplica()) return (last = { ...base, reason: "this node is the primary" });

  const lease = await readLease(t);
  if (!lease)
    // No lease at all is not an outage — it is a system that has never
    // shipped. Promoting into that would make a standby the primary of a
    // library it may not have.
    return (last = { ...base, reason: "no lease has ever been written" });

  const staleFor = Math.round((now() - lease.renewed) / 1000);
  const limit = staleSeconds();
  if (staleFor < limit)
    return (last = {
      ...base,
      lease,
      staleFor,
      reason: `the primary renewed ${staleFor}s ago`,
    });

  if (lease.holder === id)
    return (last = { ...base, lease, staleFor, promotable: true, reason: "this node holds the lease" });

  // Take it, then read it back. If another standby took it in between, that
  // one wins and this node stands down — which is the whole point.
  const took = await writeLease(t, { holder: id, renewed: now() });
  if (!took)
    return (last = { ...base, lease, staleFor, reason: "could not take the lease" });
  const confirmed = await readLease(t);
  if (confirmed?.holder !== id)
    return (last = {
      ...base,
      lease: confirmed,
      staleFor,
      reason: `another node took the lease: ${confirmed?.holder ?? "unknown"}`,
    });

  return (last = {
    ...base,
    lease: confirmed,
    staleFor,
    promotable: true,
    reason: `the lease went unrenewed for ${staleFor}s and this node took it`,
  });
}

let timer: ReturnType<typeof setInterval> | null = null;

export function scheduleFailoverWatch(): void {
  if (timer) { clearInterval(timer); timer = null; }
  if (!isReplica() || !replicaTarget()) return;
  const seconds = Math.max(15, Number(process.env.OCTAVO_FAILOVER_INTERVAL ?? "30") || 30);
  timer = setInterval(() => { void checkFailover(); }, seconds * 1000);
  timer.unref?.();
}
