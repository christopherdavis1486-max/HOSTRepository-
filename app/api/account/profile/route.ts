import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth/session";
import { accountProfileSchema, validationErrorResponse } from "@/lib/validation/schemas";
import { db } from "@/lib/db";

export async function GET(_request: NextRequest) {
  try {
    const session = await requireSession();
    const result = await db.query(
      `SELECT email, full_name, phone FROM users WHERE id = $1`,
      [session.user.id]
    );
    if (!result.rows[0]) {
      return NextResponse.json({ success: false, error: { code: "NOT_FOUND", message: "Account not found." } }, { status: 404 });
    }
    const user = result.rows[0];
    return NextResponse.json({ success: true, profile: { email: user.email, fullName: user.full_name ?? "", phone: user.phone ?? "" } });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    console.error("[HOST account/profile GET]", error);
    return NextResponse.json({ success: false, error: { code: "PROFILE_FAILED", message: "Unable to load profile." } }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await requireSession();
    const body = await request.json().catch(() => null);
    const parsed = accountProfileSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(validationErrorResponse(parsed.error), { status: 400 });
    const fullName = parsed.data.fullName?.trim() || null;
    const phone = parsed.data.phone?.trim() || null;
    const result = await db.query(
      `UPDATE users SET full_name = $2, phone = $3, updated_at = NOW()
       WHERE id = $1 RETURNING email, full_name, phone`,
      [session.user.id, fullName, phone]
    );
    if (!result.rows[0]) return NextResponse.json({ success: false, error: { code: "NOT_FOUND", message: "Account not found." } }, { status: 404 });
    const user = result.rows[0];
    return NextResponse.json({ success: true, profile: { email: user.email, fullName: user.full_name ?? "", phone: user.phone ?? "" } });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    console.error("[HOST account/profile PATCH]", error);
    return NextResponse.json({ success: false, error: { code: "UPDATE_FAILED", message: "Unable to update profile." } }, { status: 500 });
  }
}
