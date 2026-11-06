import { NextRequest, NextResponse } from "next/server";
import { requireSecureAdmin } from "@/lib/auth/adminSecurity";
import { requirePermission } from "@/lib/auth/permissions";
import { AuthError } from "@/lib/auth/session";
import {
  SetupReviewCaseError,
  getSetupReviewCases,
  updateSetupReviewCase,
} from "@/lib/payments/setupReviewCases";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

export async function PATCH(request: NextRequest) {
  try {
    const session = await requireSecureAdmin();
    await requirePermission("reconciliation", "write");

    // Browser mutations must originate from this application.
    const origin = request.headers.get("origin");
    if (!origin || origin !== request.nextUrl.origin) {
      return NextResponse.json({
        success: false,
        error: {
          code: "INVALID_ORIGIN",
          message: "Open this application before updating a review.",
        },
      }, { status: 403, headers });
    }

    const input = await request.json().catch(() => null);
    const reviewCase = await updateSetupReviewCase(session.user.id, input);
    return NextResponse.json({
      success: true,
      reviewCase,
    }, { headers });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({
        success: false,
        error: {
          code: "REVIEW_ACCESS_DENIED",
          message: "Review access is not available.",
        },
      }, { status: error.status, headers });
    }
    if (error instanceof SetupReviewCaseError) {
      return NextResponse.json({
        success: false,
        error: { code: error.code, message: error.message },
      }, { status: error.status, headers });
    }
    return NextResponse.json({
      success: false,
      error: {
        code: "REVIEW_UPDATE_FAILED",
        message: "Unable to update the review. Reload its status before trying again.",
      },
    }, { status: 500, headers });
  }
}


export async function GET(request: NextRequest) {
  try {
    await requireSecureAdmin();
    await requirePermission("reconciliation", "read");
    const reviews = await getSetupReviewCases(
      request.nextUrl.searchParams.get("bookingId") ?? "",
    );
    return NextResponse.json({ success: true, reviews }, { headers });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({
        success: false,
        error: {
          code: "REVIEW_ACCESS_DENIED",
          message: "Review access is not available.",
        },
      }, { status: error.status, headers });
    }
    if (error instanceof SetupReviewCaseError) {
      return NextResponse.json({
        success: false,
        error: { code: error.code, message: error.message },
      }, { status: error.status, headers });
    }
    return NextResponse.json({
      success: false,
      error: {
        code: "REVIEW_LOAD_FAILED",
        message: "Unable to load setup reviews.",
      },
    }, { status: 500, headers });
  }
}
