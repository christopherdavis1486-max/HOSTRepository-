import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { AuthError } from "@/lib/auth/session";
import { requireSecureAdmin } from "@/lib/auth/adminSecurity";
import { adminComplianceReviewSchema, validationErrorResponse } from "@/lib/validation/schemas";
import { getPropertyCompliance, reviewPropertyCompliance } from "@/lib/compliance/propertyCompliance";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: NextRequest) {
  try {
    await requireSecureAdmin();
    const propertyId = request.nextUrl.searchParams.get("propertyId");
    if (propertyId) {
      const compliance = await getPropertyCompliance(propertyId);
      return NextResponse.json({ success: true, compliance }, { headers });
    }
    const result = await db.query(`SELECT p.id, p.name, p.city, p.country_code, p.status, p.compliance_status, p.compliance_submitted_at, u.email AS owner_email FROM properties p JOIN host_profiles hp ON hp.id = p.host_id JOIN users u ON u.id = hp.user_id WHERE p.compliance_status IN ('submitted','changes_required') ORDER BY CASE WHEN p.compliance_status = 'submitted' THEN 0 ELSE 1 END, p.updated_at DESC`);
    return NextResponse.json({ success: true, properties: result.rows }, { headers });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status, headers });
    console.error("[HOST admin property compliance GET]", error);
    return NextResponse.json({ success: false, error: { code: "LOAD_FAILED", message: "Unable to load the compliance review queue." } }, { status: 500, headers });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await requireSecureAdmin();
    const body = await request.json();
    const propertyId = typeof body.propertyId === "string" ? body.propertyId : "";
    const parsed = adminComplianceReviewSchema.safeParse(body);
    if (!propertyId) return NextResponse.json({ success: false, error: { code: "INVALID_PROPERTY", message: "propertyId is required." } }, { status: 400, headers });
    if (!parsed.success) return NextResponse.json(validationErrorResponse(parsed.error), { status: 400, headers });
    const result = await reviewPropertyCompliance(propertyId, session.user.id, parsed.data.decision, parsed.data.note);
    return NextResponse.json({ success: true, ...result }, { headers });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status, headers });
    const message = error instanceof Error ? error.message : "Unable to review compliance.";
    const expected = message === "Property not found." || message.startsWith("Only a submitted") || message.startsWith("This record is incomplete") || message.startsWith("A property owner cannot");
    if (!expected) console.error("[HOST admin property compliance PATCH]", error);
    return NextResponse.json({ success: false, error: { code: "REVIEW_FAILED", message: expected ? message : "Unable to review compliance." } }, { status: expected ? 409 : 500, headers });
  }
}
