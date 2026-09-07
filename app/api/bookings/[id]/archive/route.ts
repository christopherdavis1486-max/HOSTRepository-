import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth/session";
import { archiveBooking } from "@/lib/booking/tripHistory";
import { BookingError } from "@/lib/booking/types";

/**
 * §5 of this brief — "Remove from My Trips." Soft-hide only; see
 * tripHistory.ts's archiveBooking() for why nothing here can ever delete
 * the underlying record. The confirmation dialog ("Remove this booking
 * from your trip history?") is a frontend concern — this route assumes
 * the frontend already confirmed with the user before calling it.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const session = await requireSession();
    const result = await archiveBooking(id, session.user.id);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    if (error instanceof BookingError) {
      const status = error.code === "BOOKING_NOT_FOUND" ? 404 : 400;
      return NextResponse.json({ success: false, error: { code: error.code, message: error.message } }, { status });
    }
    console.error("[HOST bookings/archive]", error);
    return NextResponse.json({ success: false, error: { code: "ARCHIVE_FAILED", message: "Unable to remove booking from trip history." } }, { status: 500 });
  }
}
