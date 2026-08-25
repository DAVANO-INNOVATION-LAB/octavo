import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { exportSubject } from "@/lib/subject";
import { recordAudit } from "@/lib/audit";

/**
 * Everything the instance holds about one person, as one JSON file.
 *
 * A person may ask for their own; an administrator may produce anyone's,
 * which is who actually answers these requests in practice.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (me.id !== id && me.role !== "admin")
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const data = exportSubject(id);
  recordAudit({
    actor: me,
    action: "export.subject",
    objectType: "user",
    objectId: id,
    objectLabel: (data.account?.email as string) ?? id,
  });
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="subject-${id}.json"`,
    },
  });
}
