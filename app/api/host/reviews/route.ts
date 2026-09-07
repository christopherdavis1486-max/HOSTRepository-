import { NextResponse } from "next/server";
import { requireRole, AuthError } from "@/lib/auth/session";
import { listReviewsForHost } from "@/lib/reviews/createReview";

export async function GET() {
  try {
    const session = await requireRole("host");
    if (!session.user.hostProfileId) {
      return NextResponse.json({ success: false, error: { code: "NO_HOST_PROFILE", message: "No host profile found for this account." } }, { status: 400 });
    }
    const reviews = await listReviewsForHost(session.user.hostProfileId);
    return NextResponse.json({ success: true, reviews });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    console.error("[HOST host/reviews]", error);
    return NextResponse.json({ success: false, error: { code: "LIST_FAILED", message: "Unable to load reviews." } }, { status: 500 });
  }
}
