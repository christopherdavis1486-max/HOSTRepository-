import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth/session";
import { resolveHostPropertyAccess } from "@/lib/auth/hostAccess";
import { getPropertyCompliance, saveOwnerCompliance } from "@/lib/compliance/propertyCompliance";
import { ownerComplianceSchema, validationErrorResponse } from "@/lib/validation/schemas";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const session = await requireSession();
    await resolveHostPropertyAccess(session, id);
    const compliance = await getPropertyCompliance(id);
    if (!compliance) return NextResponse.json({ success: false, error: { code: "NOT_FOUND", message: "Property not found." } }, { status: 404, headers });
    return NextResponse.json({ success: true, compliance }, { headers });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status, headers });
    console.error("[HOST property compliance GET]", error);
    return NextResponse.json({ success: false, error: { code: "LOAD_FAILED", message: "Unable to load property compliance." } }, { status: 500, headers });
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const session = await requireSession();
    await resolveHostPropertyAccess(session, id);
    const parsed = ownerComplianceSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json(validationErrorResponse(parsed.error), { status: 400, headers });
    const result = await saveOwnerCompliance(id, session.user.id, parsed.data.items, parsed.data.submit);
    return NextResponse.json({ success: true, ...result }, { headers });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status, headers });
    const message = error instanceof Error ? error.message : "Unable to save property compliance.";
    const expected = message.startsWith("Complete ");
    if (!expected) console.error("[HOST property compliance PUT]", error);
    return NextResponse.json({ success: false, error: { code: expected ? "INCOMPLETE" : "SAVE_FAILED", message: expected ? message : "Unable to save property compliance." } }, { status: expected ? 400 : 500, headers });
  }
}
