import { NextResponse } from "next/server";
import { requireRole, AuthError } from "@/lib/auth/session";
import { listStandardCancellationPolicies } from "@/lib/hosts/hostProperties";

export async function GET() {
  try {
    await requireRole("host");
    const policies = await listStandardCancellationPolicies();
    return NextResponse.json({ success: true, policies });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { success: false, error: { code: "UNAUTHORIZED", message: error.message } },
        { status: error.status }
      );
    }
    console.error("[HOST host/cancellation-policies]", error);
    return NextResponse.json(
      { success: false, error: { code: "CANCELLATION_POLICIES_FAILED", message: "Unable to load cancellation policies." } },
      { status: 500 }
    );
  }
}
