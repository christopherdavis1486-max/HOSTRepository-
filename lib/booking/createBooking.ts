import { db, withTransaction } from "../db";
import { calculatePrice, nightsBetween, getActiveFeeConfig } from "./priceEngine";
import { BookingError } from "./types";
import crypto from "crypto";
import { isDelayedChargeBookingCreationEnabled } from "../config/featureFlags";
import { decideChargeTiming } from "../payments/scheduledCharges";
import { hashToBigint } from "../utils/advisoryLock";

export type CreateBookingInput = {
  propertyId: string;
  guestId: string;
  checkIn: string; // ISO date
  checkOut: string;
  guests: number;
  guestName: string;
  guestEmail: string;
  guestPhone?: string;
  idempotencyKey: string;
};

/**
 * This function is the actual double-booking guard (technical spec §5,
 * §74). The sequence inside the transaction is what matters:
 *
 *   1. Lock every availability_blocks row in the requested date range
 *      with SELECT ... FOR UPDATE — this serializes concurrent attempts
 *      for the same property/dates; the second transaction blocks on the
 *      lock until the first commits or rolls back.
 *   2. Check the locked rows aren't already booked/blocked.
 *   3. Flip them to 'booked' and insert the booking, in the SAME
 *      transaction — so a crash between steps never leaves availability
 *      and the booking table disagreeing.
 *
 * The idempotency_key unique constraint (migration 003) handles the
 * retry/duplicate-submit case: a repeated request with the same key hits
 * the unique violation and this function returns the original booking
 * instead of creating a second one.
 */
export async function createBooking(input: CreateBookingInput) {
  const nights = nightsBetween(input.checkIn, input.checkOut);
  if (nights <= 0) throw new BookingError("INVALID_DATE_RANGE", "check_out must be after check_in");
  if (!Number.isInteger(input.guests) || input.guests < 1) throw new BookingError("INVALID_GUESTS", "guests must be a positive integer");

  return withTransaction(async (client) => {
    // Idempotency check first — cheap, avoids taking locks for a request
    // we've already processed.
    const existing = await client.query(`SELECT * FROM bookings WHERE idempotency_key = $1`, [input.idempotencyKey]);
    if (existing.rows.length > 0) return mapBookingRow(existing.rows[0]);

 
const property = await client.query(
      `SELECT p.id, p.host_id, p.currency, p.nightly_price, p.cleaning_fee,
              p.max_guests, p.min_stay_nights, p.max_stay_nights,
              p.cancellation_policy_id, p.status, p.compliance_status,
              EXISTS (
                SELECT 1
                FROM property_compliance_items i
                WHERE i.property_id = p.id
                  AND i.applicability = 'required'
                  AND i.valid_until IS NOT NULL
                  AND i.valid_until < CURRENT_DATE
              ) AS has_expired_evidence
       FROM properties p
       WHERE p.id = $1
       FOR SHARE`,
      [input.propertyId]
    );

    if (property.rows.length === 0) {
      throw new BookingError("PROPERTY_NOT_FOUND", "Property does not exist");
    }

    const p = property.rows[0];

    if (
      p.status !== "published" ||
      p.compliance_status !== "approved" ||
      p.has_expired_evidence
    ) {
      throw new BookingError(
        "PROPERTY_NOT_AVAILABLE",
        "Property is not currently available for booking"
      );
    }

     if (input.guests > p.max_guests) throw new BookingError("TOO_MANY_GUESTS", `Max ${p.max_guests} guests`);
    if (nights < p.min_stay_nights) throw new BookingError("BELOW_MIN_STAY", `Minimum stay is ${p.min_stay_nights} nights`);
    if (nights > p.max_stay_nights) throw new BookingError("ABOVE_MAX_STAY", `Maximum stay is ${p.max_stay_nights} nights`);

    // Step 1: property-level advisory lock — NOT scoped to the specific
    // date range. FOUND via a real, reproduced double-booking: two
    // DIFFERENT but overlapping date ranges (e.g. 10th-14th and
    // 12th-16th) previously hashed to DIFFERENT lock keys and never
    // contended against each other at all, and on a property with no
    // pre-existing availability_blocks rows (a fresh, never-booked
    // property), the FOR UPDATE row lock below had nothing to lock
    // either — both transactions could reach their own INSERT before
    // either committed, creating a genuine double-booking for the
    // overlapping nights. Locking on the property alone (not
    // property+dates) guarantees ANY two concurrent createBooking()
    // calls for the same property fully serialize: the second
    // transaction only proceeds once the first has committed (or rolled
    // back), so its own FOR UPDATE check below correctly sees whatever
    // the first transaction just committed. Confirmed with concurrent,
    // real-transaction tests for identical ranges, overlapping-but-
    // different ranges, and a property with zero prior availability
    // rows — see lib/booking/raceCondition.test.ts.
    const lockKey = hashToBigint(input.propertyId);
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [lockKey]);

    const blocked = await client.query(
      `SELECT date, status FROM availability_blocks
       WHERE property_id = $1 AND date >= $2 AND date < $3
       FOR UPDATE`,
      [input.propertyId, input.checkIn, input.checkOut]
    );
    const unavailable = blocked.rows.find((r: any) => r.status !== "available");
    if (unavailable) {
      throw new BookingError("DATES_UNAVAILABLE", `${unavailable.date} is not available`);
    }

    // Step 2: upsert every date in range to 'booked'. Dates with no prior
    // row are inserted directly as 'booked'.
    const dates = enumerateDates(input.checkIn, input.checkOut);
    for (const date of dates) {
      await client.query(
        `INSERT INTO availability_blocks (property_id, date, status, source)
         VALUES ($1, $2, 'booked', 'booking')
         ON CONFLICT (property_id, date) DO UPDATE SET status = 'booked', source = 'booking'`,
        [input.propertyId, date]
      );
    }

    // Step 3: price + insert, same transaction.
    const feeConfig = await getActiveFeeConfig(client);
    const breakdown = calculatePrice(
      { id: p.id, nightlyPriceMinor: toMinor(p.nightly_price), cleaningFeeMinor: toMinor(p.cleaning_fee), currency: p.currency },
      nights,
      feeConfig
    );

    let policyRules = [{ cutoffHours: 120, refundPercent: 100 }, { cutoffHours: 24, refundPercent: 50 }, { cutoffHours: 0, refundPercent: 0 }];
    if (p.cancellation_policy_id) {
      const policy = await client.query(`SELECT rules FROM cancellation_policies WHERE id = $1`, [p.cancellation_policy_id]);
      if (policy.rows.length > 0) policyRules = policy.rows[0].rules;
    }

    const isDelayedFlow = isDelayedChargeBookingCreationEnabled();
    // Decided ONCE, here, alongside payment_flow_version — never
    // recalculated later. Confirmed as a real correctness requirement:
    // the cron sweep must check a genuinely persisted date, not
    // repeatedly recompute "is this due" from check_in and the current
    // moment, which would let a booking's due-ness silently change
    // depending on when the sweep happens to run. NULL for legacy
    // bookings and for a new-flow booking decided to be immediate (no
    // deferred date — it's charged directly via the SetupIntent-success
    // webhook, never through this scheduled path at all).
    const scheduledChargeDate = isDelayedFlow ? decideChargeTiming(input.checkIn).scheduledChargeDate : null;

    const bookingResult = await client.query(
      `INSERT INTO bookings (
        property_id, guest_id, host_id, check_in, check_out, guests, status,
        cancellation_policy_snapshot, idempotency_key, hold_expires_at,
        guest_name, guest_email, guest_phone, payment_flow_version, scheduled_charge_date
      ) VALUES ($1,$2,$3,$4,$5,$6,'pending_payment',$7,$8, NOW() + INTERVAL '15 minutes', $9,$10,$11,$12,$13)
      RETURNING *`,
      [input.propertyId, input.guestId, p.host_id, input.checkIn, input.checkOut, input.guests,
       JSON.stringify(policyRules), input.idempotencyKey, input.guestName, input.guestEmail, input.guestPhone ?? null,
       // Batch 9: decided ONCE, here, at creation — payment_flow_version
       // is immutable from this point on (enforced at the database
       // level, migration 010). While ENABLE_DELAYED_CHARGE_BOOKINGS is
       // off (the default), every booking continues to get exactly the
       // same value it always has — this line changes nothing about
       // current behaviour until that flag is explicitly turned on.
       isDelayedFlow ? "separate_charges_delayed_v1" : "destination_charge_legacy",
       scheduledChargeDate]
    );
    const booking = bookingResult.rows[0];

    await client.query(
      `INSERT INTO booking_price_components (
        booking_id, currency, accommodation_minor, cleaning_minor, guest_service_fee_minor,
        taxes_minor, guest_total_minor, host_commission_minor, host_payout_minor, host_revenue_minor, fee_config_version
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [booking.id, breakdown.currency, breakdown.accommodationMinor, breakdown.cleaningMinor, breakdown.guestServiceFeeMinor,
       breakdown.taxesMinor, breakdown.guestTotalMinor, breakdown.hostCommissionMinor, breakdown.hostPayoutMinor, breakdown.hostRevenueMinor, breakdown.feeConfigVersion]
    );

    return { ...mapBookingRow(booking), breakdown };
  });
}

/** The missing piece the README's own "Scheduled jobs" section describes:
 *  releaseExpiredHold() already correctly handles ONE booking, but
 *  nothing found ALL the bookings that need it. This is that query —
 *  used by the new cron sweep endpoint, not a second expiry mechanism. */
export async function findExpiredHoldBookingIds(): Promise<string[]> {
  const result = await db.query(
    `SELECT id FROM bookings WHERE status = 'pending_payment' AND hold_expires_at IS NOT NULL AND hold_expires_at <= NOW() LIMIT 200`
  );
  return result.rows.map((r: { id: string }) => r.id);
}

/** A background sweep (not implemented here — see README) should call this
 *  for any pending_payment booking past hold_expires_at with no successful
 *  payment: release its availability_blocks rows and mark it cancelled. */
export async function releaseExpiredHold(bookingId: string) {
  return withTransaction(async (client) => {
    const booking = await client.query(`SELECT * FROM bookings WHERE id = $1 AND status = 'pending_payment' FOR UPDATE`, [bookingId]);
    if (booking.rows.length === 0) return null;
    const b = booking.rows[0];
    // A NULL hold_expires_at means this booking is genuinely reserved
    // (its payment method was saved for a long-lead delayed charge) —
    // never treat that as "expired". new Date(null) would otherwise
    // evaluate to the Unix epoch (1970), which is always in the past.
    if (b.hold_expires_at === null) return null;
    if (new Date(b.hold_expires_at) > new Date()) return null; // not actually expired yet

    await client.query(
      `UPDATE availability_blocks SET status = 'available', source = 'host'
       WHERE property_id = $1 AND date >= $2 AND date < $3 AND status = 'booked' AND source = 'booking'`,
      [b.property_id, b.check_in, b.check_out]
    );
    await client.query(`UPDATE bookings SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [bookingId]);
    return mapBookingRow({ ...b, status: "cancelled" });
  });
}

function enumerateDates(checkIn: string, checkOut: string): string[] {
  const dates: string[] = [];
  let d = new Date(checkIn);
  const end = new Date(checkOut);
  while (d < end) {
    dates.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86400000);
  }
  return dates;
}

// hashToBigint moved to ../utils/advisoryLock.ts (imported at the top of this file).

function toMinor(numericString: string | number): number {
  return Math.round(Number(numericString) * 100);
}

function mapBookingRow(row: any) {
  return {
    id: row.id,
    propertyId: row.property_id,
    guestId: row.guest_id,
    hostId: row.host_id,
    checkIn: row.check_in,
    checkOut: row.check_out,
    guests: row.guests,
    status: row.status,
    holdExpiresAt: row.hold_expires_at,
    guestName: row.guest_name,
    guestEmail: row.guest_email,
    paymentFlowVersion: row.payment_flow_version,
  };
}
