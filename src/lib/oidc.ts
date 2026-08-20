import "server-only";
import * as oidc from "openid-client";

// OIDC single sign-on — in core, never paywalled. Local accounts stay the
// zero-config default; four env vars turn on SSO against any compliant
// provider (Keycloak, Authentik, Dex, Okta, Entra, …):
//
//   OCTAVO_OIDC_ISSUER        https://auth.example.com/realms/main
//   OCTAVO_OIDC_CLIENT_ID     octavo
//   OCTAVO_OIDC_CLIENT_SECRET …
//   OCTAVO_BASE_URL           https://docs.example.com   (for the redirect URI)
//
// Optional:
//   OCTAVO_OIDC_NAME            button label (default "SSO")
//   OCTAVO_OIDC_ALLOWED_DOMAIN  only accept emails under this domain

export type OidcSettings = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  name: string;
  allowedDomain: string | null;
};

export function oidcSettings(): OidcSettings | null {
  const issuer = process.env.OCTAVO_OIDC_ISSUER;
  const clientId = process.env.OCTAVO_OIDC_CLIENT_ID;
  const clientSecret = process.env.OCTAVO_OIDC_CLIENT_SECRET;
  const baseUrl = process.env.OCTAVO_BASE_URL;
  if (!issuer || !clientId || !clientSecret || !baseUrl) return null;
  return {
    issuer,
    clientId,
    clientSecret,
    baseUrl: baseUrl.replace(/\/$/, ""),
    name: process.env.OCTAVO_OIDC_NAME || "SSO",
    allowedDomain: process.env.OCTAVO_OIDC_ALLOWED_DOMAIN || null,
  };
}

export function oidcEnabled(): boolean {
  return oidcSettings() !== null;
}

export function redirectUri(settings: OidcSettings): string {
  return `${settings.baseUrl}/api/auth/oidc/callback`;
}

declare global {
  // Discovery is one network round-trip; cache it across requests.
  var __octavoOidcConfig: Promise<oidc.Configuration> | undefined;
}

export function discover(settings: OidcSettings): Promise<oidc.Configuration> {
  if (!globalThis.__octavoOidcConfig) {
    globalThis.__octavoOidcConfig = oidc
      .discovery(
        new URL(settings.issuer),
        settings.clientId,
        settings.clientSecret,
        undefined,
        // Self-hosted IdPs on private networks are routinely plain HTTP.
        settings.issuer.startsWith("http://")
          ? { execute: [oidc.allowInsecureRequests] }
          : undefined
      )
      .catch((e) => {
        // Don't cache a failed discovery.
        globalThis.__octavoOidcConfig = undefined;
        throw e;
      });
  }
  return globalThis.__octavoOidcConfig;
}

export { oidc };
