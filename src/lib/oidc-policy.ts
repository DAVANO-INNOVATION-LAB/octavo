export function verifiedOidcEmail(claims: {email?: unknown; email_verified?: unknown}, allowedDomain: string | null): string {
  if (claims.email_verified !== true) throw new Error("Identity provider must send email_verified=true");
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Identity provider sent an invalid email");
  if (allowedDomain && email.split("@")[1] !== allowedDomain.trim().toLowerCase()) throw new Error("Email domain not allowed");
  return email;
}

export function validateOidcUrls(issuer: string, base: string): void {
  for (const raw of [issuer, base]) {
    const u = new URL(raw);
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error("Use HTTP(S) URLs without credentials, query strings or fragments");
  }
  if (new URL(base).pathname !== "/") throw new Error("Octavo base URL must be an origin without a path");
}
