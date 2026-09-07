import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth/session";
import { resolveHostPropertyAccess } from "@/lib/auth/hostAccess";
import { getHostPropertyDetail, updatePropertyForHost } from "@/lib/hosts/hostProperties";
import { updatePropertySchema, validationErrorResponse } from "@/lib/validation/schemas";
import { CompliancePublishError } from "@/lib/compliance/propertyCompliance";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const session = await requireSession();
    await resolveHostPropertyAccess(session, id); // throws 404/403 as appropriate — same centralized pattern as booking access

    const property = await getHostPropertyDetail(id);
    if (!property) {
      return NextResponse.json({ success: false, error: { code: "PROPERTY_NOT_FOUND", message: "Property not found." } }, { status: 404 });
    }
    return NextResponse.json({ success: true, property });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    console.error("[HOST host/properties/detail]", error);
    return NextResponse.json({ success: false, error: { code: "DETAIL_FAILED", message: "Unable to load property." } }, { status: 500 });
  }
}

/**
 * New this batch — property editing. Reuses the EXACT SAME
 * resolveHostPropertyAccess() ownership check as GET, not a second,
 * parallel one — a different host attempting to PATCH gets the identical
 * 403/404 behavior already verified for reads. Partial update: only
 * fields genuinely present in the request body are touched (see
 * updatePropertyForHost's own doc comment), so a form submitting just a
 * price change can never accidentally null out unrelated fields.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const session = await requireSession();
    await resolveHostPropertyAccess(session, id);

    const body = await request.json();
    const parsed = updatePropertySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(validationErrorResponse(parsed.error), { status: 400 });
    }

    await updatePropertyForHost(id, parsed.data);
    const property = await getHostPropertyDetail(id);
    return NextResponse.json({ success: true, property });
  } catch (error) {
    if (error instanceof CompliancePublishError) {
      return NextResponse.json({ success: false, error: { code: "COMPLIANCE_APPROVAL_REQUIRED", message: error.message } }, { status: 409 });
    }
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    console.error("[HOST host/properties/update]", error);
    return NextResponse.json({ success: false, error: { code: "UPDATE_FAILED", message: "Unable to update property." } }, { status: 500 });
  }
}
