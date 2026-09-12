import {
  NextRequest,
  NextResponse,
} from "next/server";
import {
  AuthError,
  requireSession,
} from "@/lib/auth/session";
import { resolveHostPropertyAccess } from "@/lib/auth/hostAccess";
import { getListingReadiness } from "@/lib/hosts/listingReadiness";

export async function GET(
  _request: NextRequest,
  {
    params,
  }: {
    params: Promise<{ id: string }>;
  }
) {
  const { id: propertyId } = await params;

  try {
    const session = await requireSession();

    await resolveHostPropertyAccess(
      session,
      propertyId
    );

    const readiness =
      await getListingReadiness(propertyId);

    if (!readiness) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "PROPERTY_NOT_FOUND",
            message: "Property not found.",
          },
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      readiness,
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
      "[HOST property-readiness]",
      error
    );

    return NextResponse.json(
      {
        success: false,
        error: {
          code:
            "LISTING_READINESS_FAILED",
          message:
            "Unable to check listing readiness.",
        },
      },
      { status: 500 }
    );
  }
}