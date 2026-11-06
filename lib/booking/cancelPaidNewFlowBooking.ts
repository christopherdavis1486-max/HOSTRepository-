import crypto from "node:crypto";
import { withTransaction } from "../db";
import { hashToBigint } from "../utils/advisoryLock";
import { reconcileCalendarAvailability } from "../calendar/calendarSync";
import { paidNewFlowCancellationEligibility } from "./paidNewFlowCancellationEligibility";
import { BookingError } from "./types";
import type { CancelBookingInput } from "./cancelBooking";

/** Reserves cancellation settlement locally; never calls a payment provider.
 * Retained payouts before transfer require a separate settlement worker.
 * Unresolved financial outcomes must be reconciled before this path can run.
 */
export async function cancelPaidNewFlowBooking(input: CancelBookingInput) {
  if (!["guest", "host", "admin", "system"].includes(input.cancelledBy)) {
    throw new BookingError("NOT_CANCELLABLE", "Invalid cancellation actor");
  }
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [hashToBigint(input.bookingId)]);
    const bookings = await client.query(
      "SELECT * FROM bookings WHERE id = $1 FOR UPDATE", [input.bookingId]
    );
    const b = bookings.rows[0];
    if (!b) throw new BookingError("BOOKING_NOT_FOUND", "Booking does not exist");
    const { payment, pc, e, transferred, notStarted, outcome } =
      await paidNewFlowCancellationEligibility(client, b, true);

    let refundId: string | null = null;
    if (outcome.refundableMinor > 0) {
      const refund = await client.query(
        `INSERT INTO new_flow_refunds
         (booking_id, payment_attempt_id, amount_minor, currency, reason, initiated_by, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending') RETURNING id`,
        [input.bookingId, payment.id, outcome.refundableMinor, pc.currency,
         input.cancelledBy + "_cancellation", input.cancelledBy]
      );
      refundId = refund.rows[0].id;
    }

    let reversalId: string | null = null;
    const reversalMinor = e.amount_minor - outcome.hostRetainedMinor;
    if (transferred && reversalMinor > 0) {
      const key = crypto.createHash("sha256")
        .update("transfer-reversal:" + e.id + ":refund:" + reversalMinor).digest("hex");
      const reversal = await client.query(
        `INSERT INTO host_transfer_reversals
         (entitlement_id, amount_minor, reason, status, idempotency_key)
         VALUES ($1, $2, 'refund', 'reversal_requested', $3) RETURNING id`,
        [e.id, reversalMinor, key]
      );
      reversalId = reversal.rows[0].id;
    }
    if (notStarted) {
      await client.query(
        "UPDATE host_transfer_entitlements SET status = $2, updated_at = NOW() WHERE id = $1",
        [e.id, outcome.hostRetainedMinor > 0
          ? "cancellation_settlement_required" : "cancelled_before_transfer"]
      );
    }

    await client.query("SELECT pg_advisory_xact_lock($1)", [hashToBigint(b.property_id)]);
    await client.query(
      "UPDATE bookings SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
      [input.bookingId]
    );
    if (!b.room_type_id) {
      await client.query(
        `DELETE FROM availability_blocks WHERE property_id = $1
         AND date >= $2 AND date < $3 AND source = 'booking'`,
        [b.property_id, b.check_in, b.check_out]
      );
      await reconcileCalendarAvailability(client, b.property_id);
    }
    const settlementId = notStarted && outcome.hostRetainedMinor > 0
      ? crypto.randomUUID() : null;
    const auditRecord = await client.query(
      `INSERT INTO audit_log(action, object_type, object_id, previous_state, new_state)
       VALUES ('booking_cancelled', 'booking', $1, $2::jsonb, $3::jsonb) RETURNING id`,
      [input.bookingId, JSON.stringify({ status: b.status }),
       JSON.stringify({
         status: "cancelled", cancelledBy: input.cancelledBy, reason: input.reason ?? null,
         paymentFlowVersion: b.payment_flow_version, cancellationKind: "paid",
         ...outcome, refundId, reversalId, settlementId, entitlementId: e.id,
         retainedPayoutSettlementRequired: notStarted && outcome.hostRetainedMinor > 0,
       })]
    );
    if (settlementId) {
      const key = crypto.createHash("sha256")
        .update("cancellation-host-settlement:" + e.id).digest("hex");
      await client.query(
        `INSERT INTO cancellation_host_settlements
         (id, booking_id, entitlement_id, host_id, payment_attempt_id,
          cancellation_audit_id, refund_id, original_host_amount_minor,
          amount_minor, guest_total_minor, refund_amount_minor,
          currency, scheduled_release_at, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [settlementId, input.bookingId, e.id, b.host_id, payment.id,
         auditRecord.rows[0].id, refundId, e.amount_minor,
         outcome.hostRetainedMinor, pc.guest_total_minor, outcome.refundableMinor,
         String(pc.currency).trim().toUpperCase(), e.scheduled_release_at, key]
      );
    }
    return {
      bookingId: input.bookingId, status: "cancelled" as const, outcome,
      currency: String(pc.currency).trim(), refundRequested: refundId !== null,
      refundId, reversalId, settlementId, refundInitiated: null,
      retainedPayoutSettlementRequired: notStarted && outcome.hostRetainedMinor > 0,
    };
  });
}
