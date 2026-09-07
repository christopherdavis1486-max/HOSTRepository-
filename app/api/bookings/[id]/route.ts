import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth/session";
import { resolveBookingAccess } from "@/lib/auth/bookingAccess";
import { getBookingDetail } from "@/lib/booking/tripHistory";
import { BookingError } from "@/lib/booking/types";

/** §7 of this brief — full booking detail view. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const session = await requireSession();
    await resolveBookingAccess(session, id); // 403/404 as appropriate
    const detail = await getBookingDetail(id);
    return NextResponse.json({ success: true, booking: detail });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    if (error instanceof BookingError) {
      return NextResponse.json({ success: false, error: { code: error.code, message: error.message } }, { status: 404 });
    }
    console.error("[HOST bookings/detail]", error);
    return NextResponse.json({ success: false, error: { code: "DETAIL_FAILED", message: "Unable to load booking." } }, { status: 500 });
  }
}
