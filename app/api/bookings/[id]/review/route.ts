import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth/session";
import { resolveBookingAccess } from "@/lib/auth/bookingAccess";
import { getReviewForBooking } from "@/lib/reviews/createReview";

/**
 * Reuses the existing resolveBookingAccess() ownership pattern (already
 * used by the messages routes) rather than inventing a second scheme —
 * only the booking's own guest or host, or an admin, may see this
 * (guest: their own review, read-only, per the batch's explicit
 * requirement; host: to know whether a reply is possible before
 * fetching the full property review list).
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const session = await requireSession();
    await resolveBookingAccess(session, id);

    const review = await getReviewForBooking(id);
    return NextResponse.json({ success: true, review });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    console.error("[HOST bookings/review]", error);
    return NextResponse.json({ success: false, error: { code: "REVIEW_FETCH_FAILED", message: "Unable to load review." } }, { status: 500 });
  }
}
