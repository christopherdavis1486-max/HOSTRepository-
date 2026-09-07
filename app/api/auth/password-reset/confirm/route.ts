import { NextRequest, NextResponse } from "next/server";
import { confirmPasswordReset } from "@/lib/auth/passwordReset";
import { passwordResetConfirmSchema, validationErrorResponse } from "@/lib/validation/schemas";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const parsed = passwordResetConfirmSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json(validationErrorResponse(parsed.error), { status: 400 });

  try {
    await confirmPasswordReset(parsed.data.token, parsed.data.newPassword);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: { code: "RESET_FAILED", message: (error as Error).message } }, { status: 400 });
  }
}
