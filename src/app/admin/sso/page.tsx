import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getSetting } from "@/lib/settings";
import { oidcFromEnv, oidcSettings } from "@/lib/oidc";
import { saveOidcAction, testOidcAction } from "@/app/actions";
import { AdminShell } from "@/components/AdminShell";

export const dynamic = "force-dynamic";

export const metadata = { title: "Single sign-on" };

function Field({
  label,
  name,
  value,
  placeholder,
  type = "text",
  disabled = false,
}: {
  label: string;
  name: string;
  value: string;
  placeholder: string;
  type?: string;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-[0.08em] text-faint">
        {label}
      </span>
      <input
        name={name}
        type={type}
        defaultValue={value}
        placeholder={placeholder}
        disabled={disabled}
        className="h-10 w-full rounded-lg border border-line bg-bg px-3 font-mono text-sm text-ink outline-none transition-colors placeholder:font-sans placeholder:text-faint focus:border-accent disabled:opacity-60"
      />
    </label>
  );
}

export default async function AdminSso({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; test?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");
  const { saved, test } = await searchParams;
  const fromEnv = oidcFromEnv();
  const active = oidcSettings();

  return (
    <AdminShell active="/admin/sso">
      {saved && (
        <p className="mb-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
          Saved. The sign-in page now offers “Continue with {active?.name ?? "SSO"}”.
        </p>
      )}
      {test === "ok" && (
        <p className="mb-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
          Discovery succeeded — the identity provider answered correctly.
        </p>
      )}
      {test && test !== "ok" && (
        <p className="mb-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
          Test failed: {test}
        </p>
      )}
      {fromEnv && (
        <p className="mb-4 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-muted">
          SSO is configured through environment variables, which take
          precedence — these fields are read-only until the env vars are
          removed.
        </p>
      )}
      <p className="mb-6 text-sm leading-relaxed text-muted">
        Works with any OpenID Connect provider — Keycloak, Authentik, Dex,
        Okta, Entra. Register a client with redirect URI{" "}
        <code className="rounded bg-surface-2 px-1 text-xs">
          {active?.baseUrl ?? "https://your-octavo"}/api/auth/oidc/callback
        </code>
        . Local accounts always keep working; SSO is in core, never paywalled.
      </p>

      <form
        action={saveOidcAction}
        className="space-y-4 rounded-2xl border border-line bg-surface p-6 shadow-card"
      >
        <Field label="Issuer URL" name="oidc_issuer" disabled={fromEnv}
          value={fromEnv ? (active?.issuer ?? "") : (getSetting("oidc_issuer") ?? "")}
          placeholder="https://auth.example.com/realms/main" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Client ID" name="oidc_client_id" disabled={fromEnv}
            value={fromEnv ? (active?.clientId ?? "") : (getSetting("oidc_client_id") ?? "")}
            placeholder="octavo" />
          <Field label="Client secret" name="oidc_client_secret" type="password" disabled={fromEnv}
            value={getSetting("oidc_client_secret") ? "********" : ""}
            placeholder="stored in the database" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Base URL of this Octavo" name="base_url" disabled={fromEnv}
            value={fromEnv ? (active?.baseUrl ?? "") : (getSetting("base_url") ?? "")}
            placeholder="https://docs.example.com" />
          <Field label="Button label" name="oidc_name" disabled={fromEnv}
            value={fromEnv ? (active?.name ?? "") : (getSetting("oidc_name") ?? "")}
            placeholder="SSO" />
        </div>
        <Field label="Allowed email domain (optional)" name="oidc_allowed_domain" disabled={fromEnv}
          value={fromEnv ? (active?.allowedDomain ?? "") : (getSetting("oidc_allowed_domain") ?? "")}
          placeholder="example.com" />
        {!fromEnv && (
          <button className="h-10 w-full rounded-lg bg-accent text-sm font-medium text-accent-ink shadow-card transition-transform hover:-translate-y-px">
            Save single sign-on settings
          </button>
        )}
      </form>
      <form action={testOidcAction} className="mt-3">
        <button className="h-9 rounded-lg border border-line bg-surface px-4 text-sm font-medium text-muted transition-colors hover:border-line-strong hover:text-ink">
          Test discovery against the issuer
        </button>
      </form>
    </AdminShell>
  );
}
