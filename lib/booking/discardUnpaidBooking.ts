import { db, withTransaction } from "../db";
import { hashToBigint } from "../utils/advisoryLock";
import { reconcileCalendarAvailability } from "../calendar/calendarSync";
import { BookingError } from "./types";
import { unpaidNewFlowCancellationEligibility } from "./unpaidNewFlowCancellationEligibility";
import {
  cleanupCancelledHotelIntent,
  VERIFIED as VERIFIED_CANCELLED_UNPAID_INTENT,
} from "../payments/cleanupCancelledHotelIntent";
import type { LegacyIntentProvider } from "../payments/cancelLegacyUnpaidIntent";

export type DiscardEligibility = {
  status: string;
  archived_at: Date | string | null;
  has_legacy_payment: boolean;
  has_verified_cancelled_legacy_intent?: boolean;
  has_successful_attempt: boolean;
  has_any_payment_attempt?: boolean;
  has_entitlement: boolean;
};

export function assertDiscardableUnpaidBooking(booking: DiscardEligibility) {
  if (booking.archived_at) throw new BookingError("ALREADY_ARCHIVED", "This booking has already been removed from My Trips");
  if (booking.status !== "pending_payment") throw new BookingError("NOT_DISCARDABLE", "Only an unpaid booking that has not been confirmed can be discarded");
  if ((booking.has_legacy_payment && !booking.has_verified_cancelled_legacy_intent) ||
      booking.has_successful_attempt ||
      (booking.has_legacy_payment && booking.has_any_payment_attempt) ||
      booking.has_entitlement) {
    throw new BookingError("PAYMENT_EXISTS", "This booking has payment activity and cannot be discarded");
  }
}

/**
 * Removes an abandoned, genuinely-unpaid checkout from My Trips without
 * deleting its financial/audit history. A legacy Stripe intent is first
 * cancelled and verified with the provider; the final booking write then
 * rechecks payment state under database locks before dates are released.
 */
export async function discardUnpaidBooking(
  bookingId: string,
  guestId: string,
  provider?: LegacyIntentProvider,
) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bookingId)) {
    throw new BookingError("BOOKING_NOT_FOUND", "Booking does not exist");
  }

  const access = await db.query(
    "SELECT status, archived_at FROM bookings WHERE id = $1 AND guest_id = $2",
    [bookingId, guestId]
  );
  if (!access.rows[0]) throw new BookingError("BOOKING_NOT_FOUND", "Booking does not exist");
  if (access.rows[0].archived_at) {
    throw new BookingError("ALREADY_ARCHIVED", "This booking has already been removed from My Trips");
  }
  if (access.rows[0].status !== "pending_payment") {
    throw new BookingError("NOT_DISCARDABLE", "Only an unpaid booking that has not been confirmed can be discarded");
  }

  const paymentExists = await db.query(
    "SELECT EXISTS (SELECT 1 FROM payments WHERE booking_id = $1) AS present",
    [bookingId]
  );
  if (paymentExists.rows[0].present) {
    if (!provider) {
      throw new BookingError("PAYMENT_EXISTS", "This booking has payment activity and cannot be discarded");
    }
    const cleanup = await cleanupCancelledHotelIntent(bookingId, provider, guestId);
    if (cleanup.outcome !== "cancelled_unpaid") {
      throw new BookingError("PAYMENT_EXISTS", "The unpaid payment could not be safely cancelled; this booking needs review");
    }
  }

  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [hashToBigint(bookingId)]);
    const result = await client.query(
      `SELECT b.*,
          EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id) AS has_legacy_payment,
          EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id AND p.provider = 'stripe' AND p.provider_payment_intent_id IS NOT NULL AND p.status = 'failed' AND p.failure_code = $3) AS has_verified_cancelled_legacy_intent,
          EXISTS (SELECT 1 FROM payment_attempts pa WHERE pa.booking_id = b.id AND pa.status = 'succeeded') AS has_successful_attempt,
          EXISTS (SELECT 1 FROM payment_attempts pa WHERE pa.booking_id = b.id) AS has_any_payment_attempt,
          EXISTS (SELECT 1 FROM host_transfer_entitlements hte WHERE hte.booking_id = b.id) AS has_entitlement
       FROM bookings b
       WHERE b.id = $1 AND b.guest_id = $2
       FOR UPDATE OF b`,
      [bookingId, guestId, VERIFIED_CANCELLED_UNPAID_INTENT]
    );
    if (!result.rows[0]) throw new BookingError("BOOKING_NOT_FOUND", "Booking does not exist");
    const booking = result.rows[0];
    // Refresh after the booking lock: payment creation may have committed
    // while this transaction waited for ownership.
    const currentPayment = await client.query(
      "SELECT EXISTS (SELECT 1 FROM payments WHERE booking_id = $1) AS present, " +
      "EXISTS (SELECT 1 FROM payments WHERE booking_id = $1 AND provider = 'stripe' AND provider_payment_intent_id IS NOT NULL AND status = 'failed' AND failure_code = $2) AS verified_cancelled",
      [bookingId, VERIFIED_CANCELLED_UNPAID_INTENT]
    );
    booking.has_legacy_payment = currentPayment.rows[0].present;
    booking.has_verified_cancelled_legacy_intent = currentPayment.rows[0].verified_cancelled;
    assertDiscardableUnpaidBooking(booking);
    if (booking.payment_flow_version === "separate_charges_delayed_v1") {
      await unpaidNewFlowCancellationEligibility(client, booking, true);
    }

    await client.query(
      `SELECT pg_advisory_xact_lock($1)`,
      [hashToBigint(booking.property_id)]
    );

    if (!booking.room_type_id) {
    await client.query(
      `DELETE FROM availability_blocks
       WHERE property_id = $1
         AND date >= $2
         AND date < $3
         AND status = 'booked'
         AND source = 'booking'`,
      [
        booking.property_id,
        booking.check_in,
        booking.check_out,
      ]
    );

    await reconcileCalendarAvailability(
      client,
      booking.property_id,
    );
    }
    await client.query(
      `UPDATE bookings SET status = 'cancelled', archived_at = NOW(), next_retry_at = NULL, updated_at = NOW()
       WHERE id = $1`,
      [bookingId]
    );
    await client.query(
      `INSERT INTO audit_log (actor_user_id, action, object_type, object_id, previous_state, new_state)
       VALUES ($1, 'unpaid_booking_discarded', 'booking', $2, $3, $4)`,
      [guestId, bookingId, JSON.stringify({ status: booking.status, archived: false }), JSON.stringify({ status: "cancelled", archived: true })]
    );
    return { bookingId, discarded: true };
  });
}
