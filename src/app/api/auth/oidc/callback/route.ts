import { NextRequest, NextResponse } from "next/server";
import { createSession, upsertOidcUser } from "@/lib/auth";
import { syncClaimGroups } from "@/lib/groups";
import { discover, oidc, oidcSettings } from "@/lib/oidc";

export async function GET(req: NextRequest) {
  const settings = oidcSettings();
  if (!settings)
    return NextResponse.json({ error: "SSO is not configured" }, { status: 404 });
  const fail = (reason: string) => {
    console.error("oidc callback rejected:", reason);
    return NextResponse.redirect(new URL("/login?error=sso", settings.baseUrl), {
      status: 303,
    });
  };

  const stashRaw = req.cookies.get("octavo_oidc")?.value;
  if (!stashRaw) return fail("missing state cookie");
  let stash: { state?: string; verifier?: string };
  try {
    stash = JSON.parse(stashRaw);
  } catch {
    return fail("bad state cookie");
  }
  if (!stash.state || !stash.verifier) return fail("incomplete state cookie");

  try {
    const config = await discover(settings);
    // Rebuild the callback URL on our canonical base so proxies can't skew it.
    const current = new URL(req.nextUrl.pathname + req.nextUrl.search, settings.baseUrl);
    const tokens = await oidc.authorizationCodeGrant(config, current, {
      pkceCodeVerifier: stash.verifier,
      expectedState: stash.state,
    });
    const claims = tokens.claims();
    if (!claims?.sub) return fail("no subject claim");

    const email = typeof claims.email === "string" ? claims.email : "";
    if (!email) return fail("identity provider sent no email claim");
    if (
      settings.allowedDomain &&
      !email.toLowerCase().endsWith(`@${settings.allowedDomain.toLowerCase()}`)
    )
      return fail(`email domain not allowed: ${email}`);

    const domain = email.split("@")[1]?.toLowerCase() ?? "";
    const role =
      settings.adminDomain && domain === settings.adminDomain.toLowerCase()
        ? "admin"
        : settings.defaultRole;
    const user = upsertOidcUser({
      issuer: settings.issuer,
      sub: claims.sub,
      email,
      name: typeof claims.name === "string" ? claims.name : "",
      role,
    });
    // Groups ride the token. Only claim-derived memberships move; anything
    // an operator granted by hand inside Octavo stays theirs to manage.
    const claimed = Array.isArray(claims.groups)
      ? claims.groups.map((g) => String(g))
      : [];
    syncClaimGroups(user.id, claimed);

    await createSession(user.id);

    const res = NextResponse.redirect(new URL("/", settings.baseUrl), {
      status: 303,
    });
    res.cookies.delete("octavo_oidc");
    return res;
  } catch (e) {
    return fail(e instanceof Error ? e.message : "token exchange failed");
  }
}
