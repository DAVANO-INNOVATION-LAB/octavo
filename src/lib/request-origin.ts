/** Compare the browser origin with the original HTTP Host, which Next may
 * normalize to localhost in req.url. Reverse proxies must preserve Host. */
export function sameOrigin(headers: Headers): boolean {
  const origin = headers.get("origin");
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.host === headers.get("host") && parsed.origin === origin;
  } catch { return false; }
}
