import "server-only";
import dgram from "node:dgram";
import net from "node:net";
import tls from "node:tls";
import os from "node:os";
import { getSetting, setSetting } from "./settings";
import { decryptSecret, encryptSecret } from "./crypto";
import { formatSyslog, octetFrame, SEVERITY, type Severity } from "./syslog";
import type { AuditEntry } from "./audit";

/**
 * Send audit events on to wherever the organisation already collects them.
 *
 * Keeping a verifiable record locally answers "what happened here". It does
 * not answer "tell me when it happens", and it does not survive the machine.
 * A security team wants the events in their own collector, under their own
 * retention, out of reach of anyone who compromises this host — which is the
 * whole point of shipping them off the box.
 *
 * Delivery is best-effort and always after the fact. The entry is already
 * committed and hash-chained by the time anything is sent, so a collector
 * that is slow, wrong, or unreachable can never delay or fail the action
 * being audited. On a disconnected network the collector is simply on the
 * same network; nothing here reaches the internet by itself.
 */

const SYSLOG = "audit_syslog";
const HTTP = "audit_http";
const HTTP_TOKEN = "audit_http_token";

export type ForwardConfig = {
  syslog: string;
  http: string;
  hasToken: boolean;
};

export function forwardConfig(): ForwardConfig {
  return {
    syslog: getSetting(SYSLOG) ?? "",
    http: getSetting(HTTP) ?? "",
    hasToken: Boolean(getSetting(HTTP_TOKEN)),
  };
}

/** Accepts udp://host:port, tcp://host:port, tls://host:port. */
function parseSyslogTarget(raw: string) {
  try {
    const u = new URL(raw);
    const proto = u.protocol.replace(":", "");
    if (!["udp", "tcp", "tls"].includes(proto)) return null;
    const port = Number(u.port) || (proto === "udp" ? 514 : 601);
    if (!u.hostname) return null;
    return { proto, host: u.hostname, port };
  } catch {
    return null;
  }
}

export function saveForwardConfig(input: {
  syslog: string;
  http: string;
  token?: string;
  clearToken?: boolean;
}) {
  const s = input.syslog.trim();
  setSetting(SYSLOG, s && parseSyslogTarget(s) ? s : null);

  const h = input.http.trim();
  let httpValue: string | null = null;
  if (h) {
    try {
      const u = new URL(h);
      if (u.protocol === "http:" || u.protocol === "https:") httpValue = u.toString();
    } catch {
      httpValue = null;
    }
  }
  setSetting(HTTP, httpValue);

  if (input.clearToken) setSetting(HTTP_TOKEN, null);
  else if (input.token) setSetting(HTTP_TOKEN, encryptSecret(input.token));
}

/** Failed sign-ins and deletions deserve more attention than a page publish. */
function severityFor(action: string): Severity {
  if (action.includes("failed") || action.endsWith(".deleted")) return SEVERITY.warning;
  if (action.startsWith("auth.") || action.startsWith("admin.")) return SEVERITY.notice;
  return SEVERITY.informational;
}

function sentence(e: AuditEntry): string {
  const what = e.object_label || e.object_id || e.object_type;
  return `${e.actor_name} ${e.action}${what ? ` ${what}` : ""}`;
}

function sendSyslog(target: ReturnType<typeof parseSyslogTarget>, line: string) {
  if (!target) return;
  const { proto, host, port } = target;

  if (proto === "udp") {
    const sock = dgram.createSocket("udp4");
    sock.send(Buffer.from(line, "utf8"), port, host, (err) => {
      if (err) console.error("audit forward: udp send failed —", err.message);
      sock.close();
    });
    return;
  }

  // Stream transports get octet framing so a collector never has to guess
  // where one record ends and the next begins.
  const payload = octetFrame(line);
  const onError = (err: Error) =>
    console.error(`audit forward: ${proto} send failed —`, err.message);

  if (proto === "tls") {
    const sock = tls.connect({ host, port, servername: host }, () => {
      sock.end(payload);
    });
    sock.setTimeout(5000, () => sock.destroy());
    sock.on("error", onError);
    return;
  }

  const sock = net.connect({ host, port }, () => sock.end(payload));
  sock.setTimeout(5000, () => sock.destroy());
  sock.on("error", onError);
}

async function sendHttp(url: string, e: AuditEntry) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const stored = getSetting(HTTP_TOKEN);
  if (stored) {
    try {
      const token = decryptSecret(stored);
      // Splunk HEC expects its own scheme; everything else takes a bearer.
      headers["Authorization"] = /splunk/i.test(url) ? `Splunk ${token}` : `Bearer ${token}`;
    } catch {
      console.error("audit forward: stored collector credential unreadable");
      return;
    }
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    await fetch(url, {
      method: "POST",
      headers,
      signal: controller.signal,
      // The hashes travel with the event so a collector holds evidence that
      // can be checked against this instance's chain later.
      body: JSON.stringify({
        time: Math.floor(e.at / 1000),
        host: os.hostname(),
        source: "octavo",
        sourcetype: "octavo:audit",
        event: {
          id: e.id,
          at: new Date(e.at).toISOString(),
          action: e.action,
          actor: e.actor_name,
          actor_id: e.actor_id,
          object_type: e.object_type,
          object_id: e.object_id,
          object_label: e.object_label,
          space_id: e.space_id,
          detail: e.detail,
          hash: e.hash,
          prev_hash: e.prev_hash,
        },
      }),
    });
    clearTimeout(timer);
  } catch (err) {
    console.error("audit forward: http send failed —", (err as Error).message);
  }
}

/**
 * Ship one entry. Never throws, never awaited by the caller: an audit trail
 * that can take the application down with it is a liability, not a control.
 */
export function forwardAudit(entry: AuditEntry): void {
  try {
    const cfg = forwardConfig();
    if (cfg.syslog) {
      sendSyslog(
        parseSyslogTarget(cfg.syslog),
        formatSyslog({
          severity: severityFor(entry.action),
          timestamp: new Date(entry.at),
          hostname: os.hostname(),
          appName: "octavo",
          msgId: entry.action,
          structured: {
            id: entry.id,
            actor: entry.actor_name,
            actorId: entry.actor_id ?? "",
            objectType: entry.object_type,
            objectId: entry.object_id,
            objectLabel: entry.object_label,
            spaceId: entry.space_id ?? "",
            hash: entry.hash,
          },
          message: sentence(entry),
        })
      );
    }
    if (cfg.http) void sendHttp(cfg.http, entry);
  } catch (err) {
    console.error("audit forward: failed —", (err as Error).message);
  }
}
