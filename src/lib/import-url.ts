import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_HOPS = 3;
const DEADLINE_MS = 15_000;
const forbidden = new BlockList();
// Non-public, documentation, benchmarking, multicast and reserved IPv4 space.
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) forbidden.addSubnet(address, prefix, "ipv4");
// IPv6 is allowlisted to native global unicast, excluding special-purpose
// allocations (including Teredo), 6to4 and documentation ranges. This also
// rejects mapped/compatible IPv4, well-known NAT64 prefixes, local, link-local
// and multicast forms. Network-specific global translation needs egress policy.
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const)
  forbidden.addSubnet(address, prefix, "ipv6");

export function isPublicImportAddress(address: string): boolean {
  if (address.includes("%")) return false;
  const family = isIP(address);
  if (family === 4) return !forbidden.check(address, "ipv4");
  return family === 6 && globalV6.check(address, "ipv6") && !forbidden.check(address, "ipv6");
}

function validateUrl(url: URL): string {
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("only http and https URLs can be imported");
  if (url.username || url.password) throw new Error("URLs with credentials cannot be imported");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const name = host.replace(/\.$/, "");
  if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local"))
    throw new Error("that address is not public address space");
  return host;
}

// Bound DNS as part of the same deadline as headers, redirects and body. A late
// OS lookup may finish, but cannot initiate a connection after cancellation.
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function open(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  const hostname = validateUrl(url);
  signal.throwIfAborted();
  const literalFamily = isIP(hostname);
  const addresses = literalFamily ? [{ address: hostname, family: literalFamily }] :
    await withAbort(lookup(hostname, { all: true, verbatim: true }), signal);
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(({ address, family }) =>
    !isPublicImportAddress(address) || isIP(address) !== family))
    throw new Error("that address is not public address space");
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    // Retain the URL hostname for Host, TLS SNI and certificate verification.
    // No pool, proxy, automatic redirects or second DNS lookup can change the
    // validated destination. All DNS answers must be public, not just this one.
    const options: RequestOptions & { autoSelectFamily: false } = {
      agent: false,
      family: pinned.family,
      autoSelectFamily: false,
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
      signal,
      maxHeaderSize: 16 * 1024,
      headers: {
        "User-Agent": "octavo-importer",
        Accept: "text/html, text/markdown, text/plain",
        "Accept-Encoding": "gzip, deflate, br",
      },
    };
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, options, resolve);
    req.on("error", reject);
    req.end();
  });
}

function byteLimit(): Transform {
  let bytes = 0;
  return new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) callback(new Error("the page is larger than 5MB"));
    else callback(null, chunk);
  } });
}

async function readBody(res: IncomingMessage, signal: AbortSignal): Promise<string> {
  const declared = res.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES))
    throw new Error("the page is larger than 5MB or has an invalid content length");
  const encoding = (res.headers["content-encoding"] ?? "identity").trim().toLowerCase();
  const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate() :
    encoding === "br" ? createBrotliDecompress() : null;
  if (!decoder && encoding !== "identity") throw new Error("unsupported page content encoding");
  const chunks: Buffer[] = [];
  const sink = new Writable({ write(chunk: Buffer, _encoding, callback) {
    chunks.push(chunk); callback();
  } });
  // Cap BOTH transfer bytes and decoded bytes, with backpressure. Never buffer
  // an unbounded response first, including when Content-Length is absent/false.
  if (decoder) await pipeline(res, byteLimit(), decoder, byteLimit(), sink, { signal });
  else await pipeline(res, byteLimit(), sink, { signal });
  return Buffer.concat(chunks).toString("utf8");
}

export async function fetchGuarded(rawUrl: string): Promise<{ body: string; finalUrl: string; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("the page request timed out")), DEADLINE_MS);
  try {
    let url = new URL(rawUrl);
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const res = await open(url, controller.signal);
      try {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          const location = res.headers.location;
          if (!location) throw new Error(`redirect without a destination (HTTP ${status})`);
          if (hop === MAX_HOPS) throw new Error("too many redirects");
          url = new URL(location, url);
          continue;
        }
        if (status < 200 || status >= 300) throw new Error(`the page answered HTTP ${status}`);
        return { body: await readBody(res, controller.signal), finalUrl: url.toString(),
          contentType: res.headers["content-type"] ?? "" };
      } finally {
        res.destroy();
      }
    }
    throw new Error("too many redirects");
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
