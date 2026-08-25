import { cookieSecure } from "@/lib/auth";
import { NextResponse } from "next/server";
import { discover, oidc, oidcSettings, redirectUri } from "@/lib/oidc";

export async function GET() {
  const settings = oidcSettings();
  if (!settings)
    return NextResponse.json({ error: "SSO is not configured" }, { status: 404 });

  try {
    const config = await discover(settings);
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    const state = oidc.randomState();

    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri(settings),
      scope: "openid email profile",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    const res = NextResponse.redirect(url);
    res.cookies.set("octavo_oidc", JSON.stringify({ state, verifier }), {
      httpOnly: true,
      sameSite: "lax",
      secure: await cookieSecure(),
      path: "/api/auth/oidc",
      maxAge: 600,
    });
    return res;
  } catch (e) {
    console.error("oidc login failed:", e);
    return NextResponse.redirect(
      new URL("/login?error=sso", settings.baseUrl),
      { status: 303 }
    );
  }
}
