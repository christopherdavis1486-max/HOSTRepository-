import { withTransaction } from "../db";
import { BookingError } from "./types";

export type DiscardEligibility = {
  status: string;
  archived_at: Date | string | null;
  has_legacy_payment: boolean;
  has_successful_attempt: boolean;
  has_entitlement: boolean;
};

export function assertDiscardableUnpaidBooking(booking: DiscardEligibility) {
  if (booking.archived_at) throw new BookingError("ALREADY_ARCHIVED", "This booking has already been removed from My Trips");
  if (booking.status !== "pending_payment") throw new BookingError("NOT_DISCARDABLE", "Only an unpaid booking that has not been confirmed can be discarded");
  if (booking.has_legacy_payment || booking.has_successful_attempt || booking.has_entitlement) {
    throw new BookingError("PAYMENT_EXISTS", "This booking has payment activity and cannot be discarded");
  }
}

/**
 * Removes an abandoned, genuinely-unpaid checkout from My Trips without
 * deleting its financial/audit history. The booking row is locked and all
 * payment proofs are checked in the same transaction before dates are freed.
 */
export async function discardUnpaidBooking(bookingId: string, guestId: string) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `SELECT b.*,
          EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id AND p.status IN ('paid','refunded','partially_refunded','disputed')) AS has_legacy_payment,
          EXISTS (SELECT 1 FROM payment_attempts pa WHERE pa.booking_id = b.id AND pa.status = 'succeeded') AS has_successful_attempt,
          EXISTS (SELECT 1 FROM host_transfer_entitlements hte WHERE hte.booking_id = b.id) AS has_entitlement
       FROM bookings b
       WHERE b.id = $1 AND b.guest_id = $2
       FOR UPDATE OF b`,
      [bookingId, guestId]
    );
    if (!result.rows[0]) throw new BookingError("BOOKING_NOT_FOUND", "Booking does not exist");
    const booking = result.rows[0];
    assertDiscardableUnpaidBooking(booking);

    await client.query(
      `UPDATE availability_blocks SET status = 'available', source = 'host'
       WHERE property_id = $1 AND date >= $2 AND date < $3
         AND status = 'booked' AND source = 'booking'`,
      [booking.property_id, booking.check_in, booking.check_out]
    );
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
