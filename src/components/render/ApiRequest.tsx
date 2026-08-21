"use client";

import { useMemo, useState } from "react";
import { Play, Loader2 } from "lucide-react";

/**
 * Send the request the page documents.
 *
 * The call is made by the reader's own browser, straight to the API. Octavo
 * never proxies it: proxying would put this instance in the path of somebody
 * else's credentials, turn a documentation server into a request forwarder
 * that could reach anything on its network, and stop working the moment the
 * API is somewhere only the reader can see.
 *
 * Nothing typed here is stored or sent anywhere else. It lives in the tab
 * until the page is closed.
 */

type ParamSpec = { name: string; in: string; required: boolean; example: string };

export function ApiRequest({
  method,
  path,
  servers,
  params,
  body,
  auth,
}: {
  method: string;
  path: string;
  servers: string;
  params: string;
  body: string;
  auth: string;
}) {
  const serverList = useMemo(
    () => servers.split("\n").map((s) => s.trim()).filter(Boolean),
    [servers]
  );
  const spec: ParamSpec[] = useMemo(() => {
    try {
      return JSON.parse(params || "[]");
    } catch {
      return [];
    }
  }, [params]);

  const [server, setServer] = useState(serverList[0] ?? "");
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(spec.map((p) => [p.name, p.example ?? ""]))
  );
  const [authValue, setAuthValue] = useState("");
  const [payload, setPayload] = useState(body);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    status: number;
    statusText: string;
    ms: number;
    text: string;
  } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const url = useMemo(() => {
    let p = path;
    for (const s of spec) {
      if (s.in === "path") {
        p = p.replace(`{${s.name}}`, encodeURIComponent(values[s.name] ?? `{${s.name}}`));
      }
    }
    const query = spec
      .filter((s) => s.in === "query" && (values[s.name] ?? "") !== "")
      .map((s) => `${encodeURIComponent(s.name)}=${encodeURIComponent(values[s.name])}`)
      .join("&");
    return `${server}${p}${query ? `?${query}` : ""}`;
  }, [server, path, spec, values]);

  async function send() {
    setBusy(true);
    setFailure(null);
    setResult(null);
    const started = performance.now();
    try {
      const headers: Record<string, string> = {};
      for (const s of spec) {
        if (s.in === "header" && (values[s.name] ?? "") !== "") headers[s.name] = values[s.name];
      }
      if (auth && authValue) headers["Authorization"] = authValue;
      const hasBody = !["GET", "HEAD"].includes(method) && payload.trim() !== "";
      if (hasBody) headers["Content-Type"] = "application/json";

      const res = await fetch(url, {
        method,
        headers,
        body: hasBody ? payload : undefined,
      });
      const raw = await res.text();
      let pretty = raw;
      try {
        pretty = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        /* not JSON; show it as it came */
      }
      setResult({
        status: res.status,
        statusText: res.statusText,
        ms: Math.round(performance.now() - started),
        text: pretty.slice(0, 20000),
      });
    } catch (err) {
      // A cross-origin refusal is the usual cause and is worth naming: the
      // request left the browser, the API simply did not allow the page to
      // read the answer.
      setFailure(
        `${(err as Error).message}. If the API does not send CORS headers for this origin, the browser will not show you the response.`
      );
    } finally {
      setBusy(false);
    }
  }

  const field =
    "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-xs text-ink outline-none focus:border-accent";

  return (
    <div className="blk-api not-prose my-4 overflow-hidden rounded-xl border border-line">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2/40 px-3 py-2">
        <span
          className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ${
            method === "GET"
              ? "bg-[rgba(59,130,246,.15)] text-[#3b82f6]"
              : method === "DELETE"
                ? "bg-[rgba(220,38,38,.12)] text-[#dc2626]"
                : "bg-accent-soft text-accent"
          }`}
        >
          {method}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{path}</span>
        <button
          type="button"
          onClick={send}
          disabled={busy || !server}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 text-xs font-medium text-accent-ink disabled:opacity-40"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
          {busy ? "Sending…" : "Send"}
        </button>
      </div>

      <div className="space-y-3 px-3 py-3">
        {serverList.length > 1 ? (
          <label className="block">
            <span className="mb-1 block text-[10px] uppercase tracking-[0.1em] text-faint">Server</span>
            <select value={server} onChange={(e) => setServer(e.target.value)} className={field}>
              {serverList.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
        ) : (
          <label className="block">
            <span className="mb-1 block text-[10px] uppercase tracking-[0.1em] text-faint">Server</span>
            <input value={server} onChange={(e) => setServer(e.target.value)} className={field} placeholder="https://api.example.com" />
          </label>
        )}

        {spec.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2">
            {spec.map((p) => (
              <label key={`${p.in}-${p.name}`} className="block">
                <span className="mb-1 block text-[10px] uppercase tracking-[0.1em] text-faint">
                  {p.name}
                  <span className="ml-1 normal-case text-faint">({p.in}{p.required ? ", required" : ""})</span>
                </span>
                <input
                  value={values[p.name] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
                  className={field}
                />
              </label>
            ))}
          </div>
        )}

        {auth && (
          <label className="block">
            <span className="mb-1 block text-[10px] uppercase tracking-[0.1em] text-faint">
              Authorization <span className="normal-case text-faint">({auth}) — stays in this tab</span>
            </span>
            <input
              value={authValue}
              onChange={(e) => setAuthValue(e.target.value)}
              placeholder="Bearer …"
              className={field}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        )}

        {body && (
          <label className="block">
            <span className="mb-1 block text-[10px] uppercase tracking-[0.1em] text-faint">Body</span>
            <textarea
              rows={Math.min(12, payload.split("\n").length + 1)}
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              className={`${field} resize-y leading-relaxed`}
              spellCheck={false}
            />
          </label>
        )}

        <p className="break-all font-mono text-[11px] text-faint">{url}</p>

        {failure && (
          <p className="rounded-md border border-[rgba(217,119,6,.4)] bg-[rgba(217,119,6,.09)] px-2.5 py-2 text-xs leading-relaxed text-ink">
            {failure}
          </p>
        )}

        {result && (
          <div className="overflow-hidden rounded-md border border-line">
            <p className="flex items-center gap-2 border-b border-line bg-surface-2/40 px-2.5 py-1.5 font-mono text-[11px]">
              <span className={result.status < 400 ? "text-[#22a05e]" : "text-[#dc2626]"}>
                {result.status} {result.statusText}
              </span>
              <span className="text-faint">{result.ms} ms</span>
            </p>
            <pre className="max-h-80 overflow-auto px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink">
              {result.text || "(empty response)"}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
