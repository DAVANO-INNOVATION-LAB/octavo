import "server-only";
import { createHash } from "node:crypto";
import * as oidc from "openid-client";
import { decryptSecret } from "./crypto";
import { getSetting } from "./settings";

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
  /** Domain whose members become admins on first SSO sign-in. */
  adminDomain: string | null;
  /** Role everyone else receives. */
  defaultRole: "member" | "admin";
};

function oidcValues() {
  // Environment wins; the admin UI (kv-stored) fills in otherwise.
  const issuer = process.env.OCTAVO_OIDC_ISSUER || getSetting("oidc_issuer");
  const clientId =
    process.env.OCTAVO_OIDC_CLIENT_ID || getSetting("oidc_client_id");
  const storedSecret = getSetting("oidc_client_secret");
  const clientSecret = process.env.OCTAVO_OIDC_CLIENT_SECRET ||
    (storedSecret?.startsWith("enc:") ? decryptSecret(storedSecret.slice(4)) : storedSecret);
  const baseUrl = process.env.OCTAVO_BASE_URL || getSetting("base_url");
  return {
    issuer,
    clientId,
    clientSecret,
    baseUrl: baseUrl?.replace(/\/$/, ""),
    name:
      process.env.OCTAVO_OIDC_NAME || getSetting("oidc_name") || "SSO",
    allowedDomain:
      process.env.OCTAVO_OIDC_ALLOWED_DOMAIN ||
      getSetting("oidc_allowed_domain") ||
      null,
    adminDomain:
      process.env.OCTAVO_OIDC_ADMIN_DOMAIN ||
      getSetting("oidc_admin_domain") ||
      null,
    defaultRole:
      (process.env.OCTAVO_OIDC_DEFAULT_ROLE ||
        getSetting("oidc_default_role")) === "admin"
        ? "admin"
        : "member",
  };
}

/** Report configuration gaps without disclosing credential values. */
export function oidcMissingFields(): string[] {
  const values = oidcValues();
  return ([ ["issuer", "Issuer URL"], ["clientId", "Client ID"],
    ["clientSecret", "Client secret (missing or unreadable)"], ["baseUrl", "Base URL of this Octavo"] ] as const)
    .filter(([key]) => !values[key]?.trim()).map(([, label]) => label);
}

export function oidcSettings(): OidcSettings | null {
  const values = oidcValues();
  if (!values.issuer?.trim() || !values.clientId?.trim() || !values.clientSecret?.trim() || !values.baseUrl?.trim()) return null;
  return values as OidcSettings;
}

/** True when OIDC came from env — the UI form should show read-only. */
export function oidcFromEnv(): boolean {
  return Boolean(process.env.OCTAVO_OIDC_ISSUER);
}

export function oidcEnabled(): boolean {
  return oidcSettings() !== null;
}

export function redirectUri(settings: OidcSettings): string {
  return `${settings.baseUrl}/api/auth/oidc/callback`;
}

declare global {
  // Discovery is one network round-trip; cache it across requests,
  // keyed by issuer and credentials so rotations take effect immediately.
  var __octavoOidcConfig:
    | { key: string; promise: Promise<oidc.Configuration> }
    | undefined;
}

export function discover(settings: OidcSettings): Promise<oidc.Configuration> {
  const key = createHash("sha256").update(JSON.stringify([settings.issuer, settings.clientId, settings.clientSecret])).digest("hex");
  if (globalThis.__octavoOidcConfig?.key !== key) {
    globalThis.__octavoOidcConfig = undefined;
  }
  if (!globalThis.__octavoOidcConfig) {
    const promise = oidc
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
        if (globalThis.__octavoOidcConfig?.key === key) globalThis.__octavoOidcConfig = undefined;
        throw e;
      });
    globalThis.__octavoOidcConfig = { key, promise };
  }
  return globalThis.__octavoOidcConfig.promise;
}

export { oidc };
