import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requestEmailVerification } from "@/lib/auth/emailVerification";
import { passwordResetRequestSchema, validationErrorResponse } from "@/lib/validation/schemas";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const parsed = passwordResetRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(validationErrorResponse(parsed.error), { status: 400 });
  }

  try {
    const result = await db.query(
      `SELECT id, email FROM users
       WHERE LOWER(email) = LOWER($1)
         AND status = 'active'
         AND email_verified_at IS NULL`,
      [parsed.data.email]
    );
    const user = result.rows[0];
    if (user) {
      await requestEmailVerification(user.id, user.email);
    }
  } catch (error) {
    console.error(
      "[HOST email-verification/request]",
      error instanceof Error ? error.message : "Verification request failed"
    );
  }

  return NextResponse.json({
    success: true,
    message: "If an eligible account exists for that email, a verification link has been sent."
  });
}