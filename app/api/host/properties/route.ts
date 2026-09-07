import { NextRequest, NextResponse } from "next/server";
import { requireRole, AuthError } from "@/lib/auth/session";
import { listPropertiesForHost, createPropertyForHost } from "@/lib/hosts/hostProperties";
import { createPropertySchema, validationErrorResponse } from "@/lib/validation/schemas";
import { CompliancePublishError } from "@/lib/compliance/propertyCompliance";

/**
 * Inherently self-scoped — unlike the booking/property DETAIL routes,
 * there's no :id to check ownership of here; requireRole("host") plus
 * reading session.user.hostProfileId IS the entire authorization
 * boundary, matching the same pattern app/api/bookings/route.ts already
 * uses for the guest side (WHERE guest_id = session.user.id).
 */
export async function GET() {
  try {
    const session = await requireRole("host");
    if (!session.user.hostProfileId) {
      return NextResponse.json({ success: false, error: { code: "NO_HOST_PROFILE", message: "No host profile found for this account." } }, { status: 400 });
    }
    const properties = await listPropertiesForHost(session.user.hostProfileId);
    return NextResponse.json({ success: true, properties });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    console.error("[HOST host/properties]", error);
    return NextResponse.json({ success: false, error: { code: "LIST_FAILED", message: "Unable to load properties." } }, { status: 500 });
  }
}

/**
 * New this batch — property creation. Always created as the
 * authenticated host's own property (host_id comes from the session,
 * never trusted from the request body). A newly created property
 * defaults to 'draft' if no status is supplied, matching the properties
 * table's own column default — so a host cannot accidentally publish a
 * half-finished listing just by omitting the status field.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireRole("host");
    if (!session.user.hostProfileId) {
      return NextResponse.json({ success: false, error: { code: "NO_HOST_PROFILE", message: "No host profile found for this account." } }, { status: 400 });
    }

    const body = await request.json();
    const parsed = createPropertySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(validationErrorResponse(parsed.error), { status: 400 });
    }

    const propertyId = await createPropertyForHost(session.user.hostProfileId, parsed.data);
    return NextResponse.json({ success: true, propertyId }, { status: 201 });
  } catch (error) {
    if (error instanceof CompliancePublishError) {
      return NextResponse.json({ success: false, error: { code: "COMPLIANCE_APPROVAL_REQUIRED", message: "Create the property as a draft, complete its compliance record, and obtain HOST approval before publishing." } }, { status: 409 });
    }
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    console.error("[HOST host/properties create]", error);
    return NextResponse.json({ success: false, error: { code: "CREATE_FAILED", message: "Unable to create property." } }, { status: 500 });
  }
}
