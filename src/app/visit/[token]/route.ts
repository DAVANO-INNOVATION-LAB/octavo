import { NextRequest, NextResponse } from "next/server";
import { getSpace } from "@/lib/data";
import { recordAudit } from "@/lib/audit";
import { spaceForVisitorToken, VISITOR_COOKIE } from "@/lib/visitors";

/**
 * The door a visitor link opens.
 *
 * The token travels in the path exactly once — here. It is exchanged for an
 * httpOnly cookie and the visitor is redirected to the space, so the secret
 * never sits in the address bar while they read, never lands in the referrer
 * header of an outbound link, and never appears in the server log of any
 * page they visit afterwards.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const spaceId = spaceForVisitorToken(token);
  const space = spaceId ? getSpace(spaceId) : null;

  if (!space) {
    // Expired, revoked, or never real: one answer for all three, so the URL
    // itself confirms nothing.
    return NextResponse.redirect(new URL("/login?error=visit", req.url), 302);
  }

  recordAudit({
    actor: null,
    action: "visit.opened",
    objectType: "space",
    objectId: space.id,
    objectLabel: space.name,
    spaceId: space.id,
  });

  const res = NextResponse.redirect(new URL(`/${space.slug}`, req.url), 302);
  res.cookies.set(VISITOR_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    // The cookie can outlive the token harmlessly — every request re-checks
    // the token itself, and a revoked token in a live cookie opens nothing.
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
