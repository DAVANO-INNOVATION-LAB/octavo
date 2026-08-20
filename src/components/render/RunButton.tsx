"use client";

import { useState } from "react";
import { CheckCircle2, ExternalLink, Play, XCircle } from "lucide-react";

type Connector = { id: string; name: string; type: string };
type LastRun = {
  status: string;
  user_name: string;
  started: number;
  output: string;
  external_url: string;
} | null;

function ago(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * The play button on a cookbook code block. Sends only the block id — the
 * server reads the saved code from the database and dispatches it.
 */
export function RunButton({
  pageId,
  blockId,
  connectors,
  lastRun,
}: {
  pageId: string;
  blockId: string;
  connectors: Connector[];
  lastRun: LastRun;
}) {
  const [connectorId, setConnectorId] = useState(connectors[0]?.id ?? "");
  const [state, setState] = useState<"idle" | "running" | "done">("idle");
  const [result, setResult] = useState<{
    status: string;
    output: string;
    externalUrl: string;
  } | null>(null);

  async function run() {
    setState("running");
    setResult(null);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageId, blockId, connectorId, params: {} }),
      });
      const data = await res.json();
      setResult({
        status: data.status ?? "failed",
        output: data.output ?? "",
        externalUrl: data.externalUrl ?? "",
      });
    } catch (e) {
      setResult({
        status: "failed",
        output: e instanceof Error ? e.message : "request failed",
        externalUrl: "",
      });
    }
    setState("done");
  }

  const shown = result ?? (lastRun ? { status: lastRun.status, output: lastRun.output, externalUrl: lastRun.external_url } : null);

  return (
    <div className="run-strip print:hidden">
      <div className="run-bar">
        <button onClick={run} disabled={state === "running" || !connectorId} className="run-play">
          <Play size={12} />
          {state === "running" ? "Running…" : "Run"}
        </button>
        {connectors.length > 1 && (
          <select
            value={connectorId}
            onChange={(e) => setConnectorId(e.target.value)}
            className="run-select"
          >
            {connectors.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        {connectors.length === 1 && (
          <span className="run-target">via {connectors[0].name}</span>
        )}
        {!result && lastRun && (
          <span className="run-last">
            last run {ago(lastRun.started)} by {lastRun.user_name} —{" "}
            <span className={lastRun.status === "succeeded" ? "run-ok" : "run-bad"}>
              {lastRun.status}
            </span>
          </span>
        )}
      </div>
      {shown && (
        <div className="run-output">
          <p className="run-status">
            {shown.status === "succeeded" ? (
              <CheckCircle2 size={13} className="run-ok" />
            ) : (
              <XCircle size={13} className="run-bad" />
            )}
            <span className={shown.status === "succeeded" ? "run-ok" : "run-bad"}>
              {shown.status}
            </span>
            {shown.externalUrl && (
              <a href={shown.externalUrl} target="_blank" rel="noopener noreferrer" className="run-link">
                open in the system <ExternalLink size={11} />
              </a>
            )}
          </p>
          {shown.output && <pre className="run-log">{shown.output}</pre>}
        </div>
      )}
    </div>
  );
}
