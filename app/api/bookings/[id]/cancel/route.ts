import { NextRequest, NextResponse } from "next/server";
import { cancelBookingAndRefund } from "@/lib/booking/cancelBooking";
import { BookingError } from "@/lib/booking/types";
import { requireSession, AuthError } from "@/lib/auth/session";
import { resolveBookingAccess } from "@/lib/auth/bookingAccess";
import { cancelBookingSchema, validationErrorResponse } from "@/lib/validation/schemas";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const session = await requireSession();

    const body = await request.json().catch(() => ({}));
    const parsed = cancelBookingSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(validationErrorResponse(parsed.error), { status: 400 });

    const { role } = await resolveBookingAccess(session, id); // throws 404/403 as appropriate

    const result = await cancelBookingAndRefund({ bookingId: id, cancelledBy: role, reason: parsed.data.reason });
    // Cancellation always succeeds here if we reach this line — the DB
    // transaction inside cancelBookingAndRefund either committed or threw
    // before this point. refundError (if set) means the Stripe refund
    // call specifically failed after the cancellation was already final —
    // a genuinely different situation from the cancellation itself failing.
    return NextResponse.json({
      success: true,
      ...result,
      warning: result.refundError ? "Booking was cancelled, but the refund could not be initiated automatically and needs manual follow-up." : undefined,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    if (error instanceof BookingError) {
      const status = error.code === "BOOKING_NOT_FOUND" ? 404 : 400;
      return NextResponse.json({ success: false, error: { code: error.code, message: error.message } }, { status });
    }
    console.error("[HOST bookings/cancel]", error);
    return NextResponse.json({ success: false, error: { code: "CANCELLATION_FAILED", message: "Unable to cancel booking." } }, { status: 500 });
  }
}
