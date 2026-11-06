import { db, withTransaction } from "../db";
import { cancelUnchargedNewFlowBooking } from "./cancelUnchargedNewFlowBooking";
import { cancelPaidNewFlowBooking } from "./cancelPaidNewFlowBooking";
import { hashToBigint } from "../utils/advisoryLock";
import { reconcileCalendarAvailability } from "../calendar/calendarSync";
import { calculateCancellation } from "./cancellationEngine";
import { BookingError } from "./types";
import { initiateRefund } from "../payments/refund";
import { sendBookingCancelledMessage } from "../messaging/systemMessages";

export type CancelBookingInput = {
  bookingId: string;
  cancelledBy: "guest" | "host" | "admin" | "system";
  reason?: string;
};

/**
 * §26-28 of the technical spec: cancellation policy evaluated → refund
 * calculated → refund initiated through the payment provider → only the
 * webhook confirming the refund actually flips status to 'refunded' (see
 * lib/payments/webhookHandler.ts's charge.refunded handler). This
 * function's job stops at "requested" — same non-negotiable as payment
 * confirmation: the frontend/API layer doesn't get to declare a refund
 * done on its own say-so.
 */
export async function cancelBooking(input: CancelBookingInput) {
  return withTransaction(async (client) => {
    const bookingResult = await client.query(
      `SELECT b.*, bpc.guest_total_minor, bpc.host_payout_minor, bpc.currency, p.id AS payment_id, p.provider_payment_intent_id, p.status AS payment_status
       FROM bookings b
       JOIN booking_price_components bpc ON bpc.booking_id = b.id
       LEFT JOIN payments p ON p.booking_id = b.id
       WHERE b.id = $1 FOR UPDATE OF b`, // scoped to `b` only — Postgres forbids FOR UPDATE across a LEFT JOIN's nullable side (payments p here), found by actually running this
      [input.bookingId]
    );
    if (bookingResult.rows.length === 0) throw new BookingError("BOOKING_NOT_FOUND", "Booking does not exist");
    const b = bookingResult.rows[0];
    if (b.payment_flow_version === "separate_charges_delayed_v1") {
      throw new BookingError(
        "NOT_CANCELLABLE",
        "This booking requires the new payment-flow cancellation process."
      );
    }


    if (!["confirmed", "pending_payment"].includes(b.status)) {
      throw new BookingError("NOT_CANCELLABLE", `Booking status '${b.status}' cannot be cancelled`);
    }

    await client.query(
      `SELECT pg_advisory_xact_lock($1)`,
      [hashToBigint(b.property_id)]
    );

    const policy = { id: "snapshot", name: "snapshot", rules: b.cancellation_policy_snapshot };
    const outcome = calculateCancellation(policy, b.check_in, b.guest_total_minor, b.host_payout_minor);

    // Release availability immediately — this doesn't wait for the refund
    // webhook, because the dates should stop blocking other guests as soon
    // as the cancellation is accepted, not only once Stripe confirms money
    // has moved.
    if (!b.room_type_id) {
    await client.query(
      `DELETE FROM availability_blocks
       WHERE property_id = $1
         AND date >= $2
         AND date < $3
         AND source = 'booking'`,
      [b.property_id, b.check_in, b.check_out]
    );

    await reconcileCalendarAvailability(
      client,
      b.property_id,
    );

    }
    await client.query(
      `UPDATE bookings SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [input.bookingId]
    );

    await client.query(
      `INSERT INTO audit_log (action, object_type, object_id, previous_state, new_state)
       VALUES ('booking_cancelled', 'booking', $1, $2, $3)`,
      [input.bookingId, JSON.stringify({ status: b.status }), JSON.stringify({ status: "cancelled", cancelledBy: input.cancelledBy, refundPercent: outcome.refundPercent })]
    );

    let refundInitiated: import("../payments/refund").InitiateRefundInput | null = null;
    if (outcome.refundableMinor > 0 && b.payment_id && b.payment_status === "paid") {
      // Initiated inside the same transaction's connection isn't possible
      // (Stripe is an external call) — call it after commit. See caller
      // pattern in app/api/bookings/[id]/cancel/route.ts.
      const reason: "guest_cancellation" | "host_cancellation" | "admin_goodwill" =
        input.cancelledBy === "guest" ? "guest_cancellation" : input.cancelledBy === "host" ? "host_cancellation" : "admin_goodwill";
      refundInitiated = {
        bookingId: input.bookingId,
        paymentId: b.payment_id,
        providerPaymentIntentId: b.provider_payment_intent_id,
        amountMinor: outcome.refundableMinor,
        currency: b.currency,
        reason,
        initiatedBy: input.cancelledBy,
      };
    }

    return { bookingId: input.bookingId, outcome, refundInitiated };
  });
}

/** Thin wrapper the API route calls after the DB transaction above commits,
 *  since the Stripe refund call is an external network request that
 *  shouldn't hold a database transaction open while it's in flight.
 *
 *  Distinguishes two genuinely different failure modes — found by
 *  actually hitting the second one in a live test: the cancellation
 *  transaction can succeed (booking cancelled, availability released,
 *  audit logged — all committed and irreversible) while the subsequent
 *  Stripe refund call fails independently. Throwing a generic error here
 *  would tell the caller "cancellation failed" when it had, in fact,
 *  already happened — misleading, and it'd make a client's natural retry
 *  hit NOT_CANCELLABLE on the now-already-cancelled booking. Instead this
 *  returns a result that's explicit about the partial-success state, so
 *  the caller (and eventually a support/ops view) can see the refund
 *  needs manual attention rather than assuming the whole action failed. */
export async function cancelBookingAndRefund(input: CancelBookingInput) {
  const flow = await db.query(
    "SELECT payment_flow_version, status FROM bookings WHERE id = $1",
    [input.bookingId]
  );
  const result = flow.rows[0]?.payment_flow_version === "separate_charges_delayed_v1"
    ? flow.rows[0].status === "confirmed"
      ? await cancelPaidNewFlowBooking(input)
      : await cancelUnchargedNewFlowBooking(input)
    : await cancelBooking(input);
  let refundError: string | null = null;
  if (result.refundInitiated) {
    try {
      await initiateRefund(result.refundInitiated);
    } catch (err) {
      refundError = (err as Error).message;
      console.error("[HOST cancelBookingAndRefund] cancellation succeeded but refund initiation failed", {
        bookingId: input.bookingId,
        error: refundError,
      });
    }
  }
  // Notify regardless of whether a refund applied — a 0%-refund
  // cancellation still needs to tell the guest their booking is cancelled.
  const refundAmountFormatted = result.outcome.refundableMinor > 0
    ? `${(result.outcome.refundableMinor / 100).toFixed(2)} ${result.refundInitiated?.currency ?? ("currency" in result ? result.currency : "")}`.trim()
    : undefined;
  const refundStatus = refundError
    ? "needs_review" as const
    : "refundRequested" in result && result.refundRequested
      ? "requested" as const : "initiated" as const;
  let notificationError: string | null = null;
  try {
    await sendBookingCancelledMessage(input.bookingId, refundAmountFormatted, refundStatus);
  } catch (err) {
    notificationError = err instanceof Error ? err.message : "Cancellation notification failed.";
    console.error("[HOST cancelBookingAndRefund] cancellation succeeded but notification failed", {
      bookingId: input.bookingId,
      error: notificationError,
    });
  }
  return { ...result, refundError, notificationError };
}
