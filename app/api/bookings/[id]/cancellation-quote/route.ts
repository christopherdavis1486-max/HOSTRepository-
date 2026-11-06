import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession, AuthError } from "@/lib/auth/session";
import { resolveBookingAccess } from "@/lib/auth/bookingAccess";
import { calculateCancellation } from "@/lib/booking/cancellationEngine";
import { paidNewFlowCancellationEligibility } from "@/lib/booking/paidNewFlowCancellationEligibility";
import { BookingError } from "@/lib/booking/types";
import { unpaidNewFlowCancellationEligibility } from "@/lib/booking/unpaidNewFlowCancellationEligibility";

/** Authenticated cancellation preview using shared financial eligibility.
 * Reads booking/payment state only; cancellation locks and rechecks before writing.
 * A later state change can invalidate a previously eligible preview.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const session = await requireSession();
    await resolveBookingAccess(session, id); // throws 404/403 as appropriate — identical check used everywhere else

    const result = await db.query(
      `SELECT b.id, b.host_id, b.status, b.payment_flow_version, b.check_in, b.cancellation_policy_snapshot,
              bpc.guest_total_minor, bpc.host_payout_minor, bpc.currency,
              EXISTS (SELECT 1 FROM payment_attempts pa WHERE pa.booking_id = b.id) AS has_attempt,
              EXISTS (SELECT 1 FROM host_transfer_entitlements hte WHERE hte.booking_id = b.id) AS has_entitlement
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
    const newFlow = b.payment_flow_version === "separate_charges_delayed_v1";
    let paidEligibility: Awaited<ReturnType<typeof paidNewFlowCancellationEligibility>> | null = null;
    if (newFlow && b.status === "confirmed") {
      try {
        paidEligibility = await paidNewFlowCancellationEligibility(db, b);
      } catch (error) {
        if (!(error instanceof BookingError) || error.code !== "NOT_CANCELLABLE") throw error;
      }
    }
    let unpaidEligible = false;
    if (newFlow && b.status === "pending_payment") {
      try {
        await unpaidNewFlowCancellationEligibility(db, b);
        unpaidEligible = true;
      } catch (error) {
        if (!(error instanceof BookingError) || error.code !== "NOT_CANCELLABLE") throw error;
      }
    }
    const cancellable = newFlow
      ? paidEligibility !== null || unpaidEligible
      : ["confirmed", "pending_payment"].includes(b.status);
    if (!cancellable) {
      return NextResponse.json({
        success: true,
        quote: {
          bookingId: id,
          eligible: false,
          reason: newFlow
            ? "This booking requires cancellation with payment reconciliation or is no longer pending."
            : `Bookings with status '${b.status}' cannot be cancelled.`,
          currency: b.currency,
        },
      });
    }

    const policy = { id: "snapshot", name: "snapshot", rules: b.cancellation_policy_snapshot };
    const outcome = paidEligibility?.outcome ?? (newFlow
      ? { refundPercent: 0, refundableMinor: 0, hostRetainedMinor: 0 }
      : calculateCancellation(policy, b.check_in, b.guest_total_minor, b.host_payout_minor));

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
