import { currentUser } from "@/lib/auth";
import { listAudit, recordAudit, verifyChain } from "@/lib/audit";

/**
 * The whole log as JSON-lines, hashes included, so an auditor can verify it
 * away from the running instance. Exporting is itself an audited event.
 */
export async function GET() {
  const user = await currentUser();
  if (!user || user.role !== "admin")
    return new Response("unauthorized", { status: 401 });

  const chain = verifyChain();
  const entries = listAudit({ limit: 1000 });
  const header = JSON.stringify({
    exported_at: new Date().toISOString(),
    entries: chain.entries,
    head: chain.head,
    chain_ok: chain.ok,
  });
  const body = [header, ...entries.map((e) => JSON.stringify(e))].join("\n");

  recordAudit({
    actor: user,
    action: "export.audit_log",
    objectType: "audit_log",
    objectLabel: `${entries.length} entries`,
  });

  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="octavo-audit.jsonl"`,
    },
  });
}
