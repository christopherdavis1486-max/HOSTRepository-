import { NextRequest, NextResponse } from "next/server";
import { getHostOnboardingStatus } from "@/lib/hosts/onboarding";
import { requireRole, AuthError } from "@/lib/auth/session";

export async function GET(_request: NextRequest) {
  try {
    const session = await requireRole("host"); // only a host can check their own onboarding status
    if (!session.user.hostProfileId) {
      return NextResponse.json({ success: true, status: "not_connected" });
    }
    const status = await getHostOnboardingStatus(session.user.hostProfileId);
    return NextResponse.json({ success: true, ...status });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: { code: "STATUS_CHECK_FAILED", message: (error as Error).message } }, { status: 400 });
  }
}
