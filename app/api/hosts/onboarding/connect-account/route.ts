import { NextRequest, NextResponse } from "next/server";
import { startHostConnectOnboarding, ensureHostProfile } from "@/lib/hosts/onboarding";
import { requireSession, AuthError } from "@/lib/auth/session";
import { hostOnboardingStartSchema, validationErrorResponse } from "@/lib/validation/schemas";

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession(); // any signed-in user can start becoming a host

    const body = await request.json().catch(() => null);
    const parsed = hostOnboardingStartSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(validationErrorResponse(parsed.error), { status: 400 });

    const hostProfileId = await ensureHostProfile(session.user.id);
    const baseUrl = process.env.APP_URL ?? request.nextUrl.origin;

    const { onboardingUrl } = await startHostConnectOnboarding(
      hostProfileId, parsed.data.country, session.user.email ?? "",
      `${baseUrl}/host/onboarding/complete`,
      `${baseUrl}/host/onboarding/connect-account`
    );
    return NextResponse.json({ success: true, onboardingUrl });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    console.error("[HOST hosts/onboarding]", error);
    return NextResponse.json({ success: false, error: { code: "ONBOARDING_FAILED", message: (error as Error).message } }, { status: 400 });
  }
}
