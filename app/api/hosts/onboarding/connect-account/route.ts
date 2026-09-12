import {
  NextRequest,
  NextResponse,
} from "next/server";
import {
  ensureHostProfile,
  recordHostAgreementAcceptance,
  startHostConnectOnboarding,
} from "@/lib/hosts/onboarding";
import {
  AuthError,
  requireSession,
} from "@/lib/auth/session";
import {
  hostOnboardingStartSchema,
  validationErrorResponse,
} from "@/lib/validation/schemas";

export async function POST(
  request: NextRequest
) {
  try {
    // Any signed-in user may begin becoming a host.
    const session = await requireSession();

    const body = await request
      .json()
      .catch(() => null);

    const parsed =
      hostOnboardingStartSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        validationErrorResponse(parsed.error),
        { status: 400 }
      );
    }

    const hostProfileId =
      await ensureHostProfile(session.user.id);

    // Validation above proves both required acceptances were explicit
    // true values. The server records the authoritative agreement
    // version and timestamps; clients cannot choose their own version.
    await recordHostAgreementAcceptance(
      hostProfileId
    );

    const baseUrl =
      process.env.APP_URL ??
      request.nextUrl.origin;

    const { onboardingUrl } =
      await startHostConnectOnboarding(
        hostProfileId,
        parsed.data.country,
        session.user.email ?? "",
        `${baseUrl}/host/onboarding/complete`,
        `${baseUrl}/host/onboarding/connect-account`
      );

    return NextResponse.json({
      success: true,
      onboardingUrl,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "UNAUTHORIZED",
            message: error.message,
          },
        },
        { status: error.status }
      );
    }

    console.error(
      "[HOST hosts/onboarding]",
      error
    );

    return NextResponse.json(
      {
        success: false,
        error: {
          code: "ONBOARDING_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "Unable to start host onboarding.",
        },
      },
      { status: 400 }
    );
  }
}