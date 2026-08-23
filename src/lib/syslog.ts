/**
 * RFC 5424 syslog formatting.
 *
 * Every collector an operator already runs — rsyslog, syslog-ng, Splunk,
 * Elastic, a SIEM appliance — speaks this. Emitting it means audit events
 * reach the place an auditor already looks, without asking anyone to install
 * a shipper next to a single-container application.
 *
 * Pure, so the wire format can be tested against the specification rather
 * than against whatever a collector happened to accept.
 */

/** Facility 13 is "log audit" in RFC 5424 Table 1. */
export const FACILITY_LOG_AUDIT = 13;

export const SEVERITY = {
  warning: 4,
  notice: 5,
  informational: 6,
} as const;

export type Severity = (typeof SEVERITY)[keyof typeof SEVERITY];

/**
 * Structured data values escape `"`, `\` and `]` — the three characters that
 * would otherwise end a parameter or the element early and silently corrupt
 * every field after them.
 */
export function escapeSdValue(value: string): string {
  return value.replace(/([\\"\]])/g, "\\$1");
}

/** A printable ASCII field, or the nil value. Syslog has no empty fields. */
function field(value: string | null | undefined, max = 48): string {
  if (!value) return "-";
  const clean = value
    .replace(/[^\x21-\x7e]/g, "")
    .slice(0, max);
  return clean || "-";
}

export type SyslogMessage = {
  severity: Severity;
  timestamp: Date;
  hostname: string;
  appName: string;
  /** The event type, which becomes MSGID and is what a rule filters on. */
  msgId: string;
  structured: Record<string, string>;
  message: string;
};

/**
 * Build one RFC 5424 line.
 *
 * The structured-data element carries the fields a rule needs to match on,
 * and the free-text message carries the sentence a person reads. Putting the
 * fields only in the message would force every collector to parse English.
 */
export function formatSyslog(m: SyslogMessage): string {
  const pri = FACILITY_LOG_AUDIT * 8 + m.severity;
  const ts = m.timestamp.toISOString();
  const sd = Object.entries(m.structured)
    .filter(([, v]) => v !== "" && v !== undefined && v !== null)
    .map(([k, v]) => `${k.replace(/[^A-Za-z0-9_]/g, "")}="${escapeSdValue(String(v))}"`)
    .join(" ");
  // The enterprise number is IANA's "example" range; an operator filtering on
  // the element name never needs it to be registered.
  const structured = sd ? `[octavo@32473 ${sd}]` : "-";
  const msg = m.message.replace(/[\r\n]+/g, " ").trim();
  return `<${pri}>1 ${ts} ${field(m.hostname, 255)} ${field(m.appName, 48)} ${field(String(process.pid), 128)} ${field(m.msgId, 32)} ${structured} ${msg}`;
}

/** Framing for syslog over TCP: RFC 6587 octet counting. */
export function octetFrame(line: string): string {
  return `${Buffer.byteLength(line, "utf8")} ${line}`;
}
