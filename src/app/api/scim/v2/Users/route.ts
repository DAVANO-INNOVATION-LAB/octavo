import { NextRequest, NextResponse } from "next/server";
import { scimAuthorized, scimCreate, scimList } from "@/lib/scim";
import { recordAudit } from "@/lib/audit";

const SCIM_TYPE = "application/scim+json";

function deny() {
  return NextResponse.json(
    { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "401" },
    { status: 401 }
  );
}

/** GET /api/scim/v2/Users — list, or lookup by userName filter. */
export async function GET(req: NextRequest) {
  if (!scimAuthorized(req.headers.get("authorization"))) return deny();
  const q = req.nextUrl.searchParams;
  const body = scimList(
    q.get("filter"),
    Math.max(1, Number(q.get("startIndex")) || 1),
    Math.min(200, Number(q.get("count")) || 100)
  );
  return NextResponse.json(body, { headers: { "Content-Type": SCIM_TYPE } });
}

/** POST /api/scim/v2/Users — provision an account. */
export async function POST(req: NextRequest) {
  if (!scimAuthorized(req.headers.get("authorization"))) return deny();
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ status: "400" }, { status: 400 });
  }
  const result = scimCreate(body);
  if ("conflict" in result)
    return NextResponse.json(
      {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        status: "409",
        detail: "userName already exists or is not an email address",
      },
      { status: 409 }
    );
  recordAudit({
    actor: null,
    action: "user.created",
    objectType: "user",
    objectId: result.id,
    objectLabel: `${result.userName} (SCIM)`,
  });
  return NextResponse.json(result, {
    status: 201,
    headers: { "Content-Type": SCIM_TYPE },
  });
}
