import { withTransaction } from "../db";
import { unpaidNewFlowCancellationEligibility } from "./unpaidNewFlowCancellationEligibility";
import { hashToBigint } from "../utils/advisoryLock";
import { reconcileCalendarAvailability } from "../calendar/calendarSync";
import { BookingError } from "./types";
import type { CancelBookingInput } from "./cancelBooking";

/** Cancels pending new-flow bookings with no attempt or audited terminal nonpayment.
 * The booking advisory lock serializes this decision with charge reservation.
 * This function performs no payment-provider calls.
 */
export async function cancelUnchargedNewFlowBooking(input: CancelBookingInput) {
  if (!["guest", "host", "admin", "system"].includes(input.cancelledBy)) {
    throw new BookingError("NOT_CANCELLABLE", "Invalid cancellation actor");
  }

  return withTransaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock($1)",
      [hashToBigint(input.bookingId)]
    );
    const result = await client.query(
      "SELECT * FROM bookings WHERE id = $1 FOR UPDATE",
      [input.bookingId]
    );
    if (result.rows.length !== 1) {
      throw new BookingError("BOOKING_NOT_FOUND", "Booking does not exist");
    }
    const booking = result.rows[0];
    if (
      booking.payment_flow_version !== "separate_charges_delayed_v1" ||
      booking.status !== "pending_payment"
    ) {
      throw new BookingError(
        "NOT_CANCELLABLE",
        "Booking is not an uncharged pending new-flow booking"
      );
    }

    const eligibility = await unpaidNewFlowCancellationEligibility(client, booking, true);

    await client.query(
      "SELECT pg_advisory_xact_lock($1)",
      [hashToBigint(booking.property_id)]
    );
    await client.query(
      "UPDATE bookings SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
      [input.bookingId]
    );

    if (!booking.room_type_id) {
      await client.query(
        `DELETE FROM availability_blocks
         WHERE property_id = $1 AND date >= $2 AND date < $3
           AND source = 'booking'`,
        [booking.property_id, booking.check_in, booking.check_out]
      );
      await reconcileCalendarAvailability(client, booking.property_id);
    }

    await client.query(
      `INSERT INTO audit_log (action, object_type, object_id, previous_state, new_state)
       VALUES ('booking_cancelled', 'booking', $1, $2::jsonb, $3::jsonb)`,
      [
        input.bookingId,
        JSON.stringify({ status: booking.status }),
        JSON.stringify({
          status: "cancelled",
          cancelledBy: input.cancelledBy,
          reason: input.reason ?? null,
          paymentFlowVersion: booking.payment_flow_version,
          cancellationKind: eligibility.kind,
          reconciledPaymentAttemptId: eligibility.attemptId,
          refundRequested: false,
        }),
      ]
    );
    return {
      bookingId: input.bookingId,
      status: "cancelled" as const,
      refundRequested: false,
      outcome: { refundPercent: 0, refundableMinor: 0, hostRetainedMinor: 0 },
      refundInitiated: null,
    };
  });
}
