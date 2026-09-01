import { NextResponse } from "next/server";
import { isReplica } from "@/lib/db";
import { lastShipResult } from "@/lib/replicate";
import { lastPullResult } from "@/lib/replica";
import { checkFailover } from "@/lib/failover";
import { lastDrill } from "@/lib/restore-drill";

export const dynamic = "force-dynamic";

/**
 * What a load balancer, an orchestrator, or a person on call needs to know.
 *
 * Deliberately unauthenticated and deliberately dull: it says whether this
 * node is serving, which role it believes it has, and whether a standby has
 * become promotable. It does not name a bucket, an endpoint, a key, or a
 * page — a health endpoint that leaks the shape of the deployment is a
 * reconnaissance tool.
 *
 * 200 while serving. A promotable standby still answers 200, because it IS
 * still serving reads; `promotable` is the signal to act on, not the status
 * code, and turning a working replica into a failing health check would take
 * it out of the load balancer at exactly the wrong moment.
 */
export async function GET() {
  const replica = isReplica();
  const failover = replica ? await checkFailover() : null;
  const drill = replica ? null : lastDrill();
  const ship = replica ? null : lastShipResult();
  const pull = replica ? lastPullResult() : null;

  return NextResponse.json(
    {
      ok: true,
      role: replica ? "standby" : "primary",
      ...(pull ? { lastPull: { ok: pull.ok, at: pull.at, changed: pull.changed ?? false } } : {}),
      ...(ship ? { lastBackup: { ok: ship.ok, at: ship.at, verified: ship.verified ?? false } } : {}),
      ...(drill
        ? { lastRestoreDrill: { ok: drill.ok, at: drill.at, pages: drill.pages ?? 0 } }
        : {}),
      ...(failover
        ? { promotable: failover.promotable, reason: failover.reason }
        : {}),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
