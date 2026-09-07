import { NextRequest, NextResponse } from "next/server";
import { requestPasswordReset } from "@/lib/auth/passwordReset";
import { passwordResetRequestSchema, validationErrorResponse } from "@/lib/validation/schemas";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const parsed = passwordResetRequestSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json(validationErrorResponse(parsed.error), { status: 400 });

  try {
    await requestPasswordReset(parsed.data.email);
  } catch (error) {
    // Logged, but still returns success below — never reveal whether the
    // failure was "email doesn't exist" vs. "email provider errored."
    console.error("[HOST password-reset/request]", error);
  }

  // Always the same response regardless of outcome — account enumeration
  // protection, same reasoning as registration.
  return NextResponse.json({ success: true, message: "If an account exists for that email, a reset link has been sent." });
}
