import { NextRequest, NextResponse } from "next/server";
import { scimAuthorized, scimGet, scimPatch, scimReplace } from "@/lib/scim";
import { recordAudit } from "@/lib/audit";

const SCIM_TYPE = "application/scim+json";

function deny() {
  return NextResponse.json(
    { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "401" },
    { status: 401 }
  );
}
function missing() {
  return NextResponse.json(
    { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "404" },
    { status: 404 }
  );
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!scimAuthorized(req.headers.get("authorization"))) return deny();
  const { id } = await params;
  const user = scimGet(id);
  return user
    ? NextResponse.json(user, { headers: { "Content-Type": SCIM_TYPE } })
    : missing();
}

/** PATCH — the deactivate/reactivate call every provisioner makes. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!scimAuthorized(req.headers.get("authorization"))) return deny();
  const { id } = await params;
  if (!scimGet(id)) return missing();
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ status: "400" }, { status: 400 });
  }
  const user = scimPatch(id, Array.isArray(body?.Operations) ? body.Operations : []);
  recordAudit({
    actor: null,
    action: "user.role_changed",
    objectType: "user",
    objectId: id,
    objectLabel: `${user?.userName ?? id} active=${user?.active} (SCIM)`,
  });
  return NextResponse.json(user, { headers: { "Content-Type": SCIM_TYPE } });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!scimAuthorized(req.headers.get("authorization"))) return deny();
  const { id } = await params;
  if (!scimGet(id)) return missing();
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ status: "400" }, { status: 400 });
  }
  const user = scimReplace(id, body);
  return NextResponse.json(user, { headers: { "Content-Type": SCIM_TYPE } });
}
