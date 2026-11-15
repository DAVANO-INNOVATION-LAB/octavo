/** Disabled-by-default, one-shot staging transport prototype. No application integration. */
import https from 'node:https';
import { checkServerIdentity, type TLSSocket } from 'node:tls';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const HARD_BYTES = 32 * 1024 * 1024;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const validPin = (pin: string) => /^[a-f0-9]{64}$/.test(pin);
const validLineage = (lineage: string) => /^[A-Za-z0-9_-]{1,128}$/.test(lineage);
function limits(maxBytes: number, timeoutMs: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > HARD_BYTES ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Invalid transport limits');
}
function scope(bytes: Buffer, lineage: string) {
  const parsed = JSON.parse(bytes.toString('utf8'));
  if (parsed?.payload?.lineage !== lineage || !['octavo-exchange-v1', 'octavo-exchange-delta-v1'].includes(parsed?.payload?.format)) throw new Error('Invalid staged bundle scope');
}
export type StagingDestination = {
  enabled: boolean;
  endpoint: string;
  /** Literal enrolled address: DNS is never consulted. */
  address: string;
  serverCertificateSha256: string;
  lineage: string;
  ca: string | Buffer;
  clientCertificate: string | Buffer;
  clientKey: string | Buffer;
  maxBytes: number;
  timeoutMs: number;
};
/** Sends exactly once to the enrolled mTLS peer. No retries, redirects, cookies or ambient proxy. */
export async function stageAtPeer(config: StagingDestination, bytes: Buffer): Promise<{ staged: true; sha256: string }> {
  if (!config.enabled) throw new Error('Transport is disabled');
  limits(config.maxBytes, config.timeoutMs);
  const url = new URL(config.endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['127.0.0.1', '::1'].includes(config.address) ||
      (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0 && url.hostname.replace(/^\[|\]$/g, '') !== config.address) ||
      !validPin(config.serverCertificateSha256) || !validLineage(config.lineage)) throw new Error('Invalid enrolled destination');
  if (!config.ca || !config.clientCertificate || !config.clientKey) throw new Error('Mutual TLS credentials required');
  if (!Buffer.isBuffer(bytes) || bytes.length > config.maxBytes) throw new Error('Transport bundle exceeds limit');
  scope(bytes, config.lineage);
  const digest = hash(bytes);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: { staged: true; sha256: string }) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) reject(new Error('Staging transport failed')); else resolve(result!);
    };
    const request = https.request(url, {
      method: 'POST', agent: false, ca: config.ca, cert: config.clientCertificate, key: config.clientKey,
      minVersion: 'TLSv1.3', rejectUnauthorized: true,
      lookup: (_hostname, options, callback) => {
        const entry = { address: config.address, family: isIP(config.address) };
        if (options.all) callback(null, [entry]); else callback(null, entry.address, entry.family);
      },
      checkServerIdentity: (hostname, cert) => checkServerIdentity(hostname, cert) ||
        (cert.raw && hash(cert.raw) === config.serverCertificateSha256 ? undefined : new Error('Peer certificate pin mismatch')),
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length,
        'X-Octavo-Lineage': config.lineage, 'Accept-Encoding': 'identity' },
    }, response => {
      if (response.statusCode !== 202 || response.headers['content-encoding'] ||
          response.headers['content-type'] !== 'application/json') { response.destroy(); request.destroy(); finish(new Error('Unexpected staging response')); return; }
      const chunks: Buffer[] = []; let total = 0;
      response.on('data', chunk => { total += chunk.length; if (total > 4096) { response.destroy(); request.destroy(); finish(new Error('Oversized receipt')); } else chunks.push(chunk); });
      response.on('error', finish);
      response.on('aborted', () => finish(new Error('Interrupted receipt')));
      response.on('end', () => {
        try { const receipt = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (receipt.staged !== true || receipt.sha256 !== digest || receipt.lineage !== config.lineage) throw new Error('Receipt mismatch');
          finish(undefined, { staged: true, sha256: digest });
        } catch { finish(new Error('Invalid staging receipt')); }
      });
    });
    const timer = setTimeout(() => { request.destroy(); finish(new Error('Staging timeout')); }, config.timeoutMs);
    request.on('error', finish);
    request.end(bytes);
  });
}
export type StagingReceiver = {
  enabled: boolean;
  path: string;
  /** Exact client certificate digest and its one enrolled lineage. */
  clientCertificateSha256: string;
  lineage: string;
  maxBytes: number;
  timeoutMs: number;
  /** Must verify envelope/origin signatures and attachments without applying pages. */
  verifyBundle: (bytes: Buffer) => Promise<void> | void;
  /** Must persist privately, durably and idempotently by digest before returning.
   * No page application. A timeout cannot cancel this callback: completion may be
   * ambiguous without an acknowledgement, so operator retries must reuse the digest. */
  stage: (item: { sha256: string; lineage: string; bytes: Buffer }) => Promise<void>;
};
/** Attach only to an HTTPS server configured with requestCert and rejectUnauthorized. */
export function createStagingHandler(config: StagingReceiver) {
  limits(config.maxBytes, config.timeoutMs);
  if (!validPin(config.clientCertificateSha256) || !validLineage(config.lineage) ||
      !/^\/[A-Za-z0-9/_-]+$/.test(config.path)) throw new Error('Invalid receiver enrollment');
  return async (request: IncomingMessage, response: ServerResponse) => {
    const reply = (status: number, body: object) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body));
    };
    if (!config.enabled) { reply(503, { error: 'Transport disabled' }); return; }
    const socket = request.socket as TLSSocket;
    if (!socket.encrypted || socket.getProtocol() !== 'TLSv1.3' || !socket.authorized || !socket.getPeerCertificate()?.raw ||
        hash(socket.getPeerCertificate().raw) !== config.clientCertificateSha256) { reply(403, { error: 'Peer denied' }); return; }
    if (request.method !== 'POST' || request.url !== config.path || request.headers['x-octavo-lineage'] !== config.lineage ||
        request.headers['content-type'] !== 'application/octet-stream' || request.headers['content-encoding'] ||
        request.headers['transfer-encoding']) { reply(400, { error: 'Invalid staging request' }); return; }
    const lengthHeader = request.headers['content-length'];
    if (typeof lengthHeader !== 'string' || !/^\d+$/.test(lengthHeader) || !Number.isSafeInteger(Number(lengthHeader)) || Number(lengthHeader) > config.maxBytes) { reply(413, { error: 'Bundle limit' }); return; }
    let expired = false;
    const timer = setTimeout(() => { expired = true; request.destroy(); response.destroy(); }, config.timeoutMs);
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > config.maxBytes) throw new Error('Bundle limit'); chunks.push(chunk); }
      if (size !== Number(lengthHeader) || expired) throw new Error('Incomplete body');
      const bytes = Buffer.concat(chunks); scope(bytes, config.lineage);
      await config.verifyBundle(bytes);
      if (expired) throw new Error('Verification timeout');
      // stage is idempotent by digest; no document state is touched here.
      await config.stage({ sha256: hash(bytes), lineage: config.lineage, bytes });
      if (!expired) reply(202, { staged: true, sha256: hash(bytes), lineage: config.lineage });
    } catch { reply(409, { error: 'Bundle not acknowledged' }); }
    finally { clearTimeout(timer); }
  };
}
