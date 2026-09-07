import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession, AuthError } from "@/lib/auth/session";
import { resolveBookingAccess } from "@/lib/auth/bookingAccess";
import { calculateCancellation } from "@/lib/booking/cancellationEngine";

/**
 * NEW — the read-only cancellation preview the batch brief asked for.
 * Reuses calculateCancellation() DIRECTLY — the exact same function
 * lib/booking/cancelBooking.ts calls for the real, authoritative
 * cancellation — imported, not reimplemented. Same policy construction
 * too: `{ id: "snapshot", name: "snapshot", rules: booking.cancellation_policy_snapshot }`,
 * copied verbatim from cancelBooking.ts's own code rather than
 * approximated, so a quote can never drift from what actually happens
 * when the guest confirms.
 *
 * Read-only, guaranteed structurally, not just by convention: this
 * function contains zero UPDATE/INSERT statements, no call to
 * initiateRefund, no call to cancelBooking. It cannot modify anything
 * even in principle.
 *
 * Ownership enforced via the same resolveBookingAccess() every other
 * booking-scoped route already uses — 404 for a nonexistent booking,
 * 403 for a booking that exists but isn't the caller's.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const session = await requireSession();
    await resolveBookingAccess(session, id); // throws 404/403 as appropriate — identical check used everywhere else

    const result = await db.query(
      `SELECT b.status, b.check_in, b.cancellation_policy_snapshot, bpc.guest_total_minor, bpc.host_payout_minor, bpc.currency
       FROM bookings b
       JOIN booking_price_components bpc ON bpc.booking_id = b.id
       WHERE b.id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return NextResponse.json({ success: false, error: { code: "BOOKING_NOT_FOUND", message: "Booking does not exist" } }, { status: 404 });
    }
    const b = result.rows[0];

    // Same eligibility check as cancelBooking.ts's own code, copied
    // verbatim — a quote must never claim a booking is cancellable if
    // the real cancel endpoint would then reject it.
    const cancellable = ["confirmed", "pending_payment"].includes(b.status);
    if (!cancellable) {
      return NextResponse.json({
        success: true,
        quote: {
          bookingId: id,
          eligible: false,
          reason: `Bookings with status '${b.status}' cannot be cancelled.`,
          currency: b.currency,
        },
      });
    }

    const policy = { id: "snapshot", name: "snapshot", rules: b.cancellation_policy_snapshot };
    const outcome = calculateCancellation(policy, b.check_in, b.guest_total_minor, b.host_payout_minor);

    return NextResponse.json({
      success: true,
      quote: {
        bookingId: id,
        eligible: true,
        refundPercent: outcome.refundPercent,
        refundableMinor: outcome.refundableMinor,
        hostRetainedMinor: outcome.hostRetainedMinor,
        currency: b.currency,
        policyTiers: b.cancellation_policy_snapshot,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    console.error("[HOST bookings/cancellation-quote]", error);
    return NextResponse.json({ success: false, error: { code: "QUOTE_FAILED", message: "Unable to calculate a cancellation quote." } }, { status: 500 });
  }
}
