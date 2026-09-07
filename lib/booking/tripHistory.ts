import { db } from "../db";
import { BookingError } from "./types";
import { deriveGuestPaymentStatus, GRACE_PERIOD_HOURS } from "../payments/scheduledCharges";

/** Statuses eligible for "remove from My Trips" (§5-6). Deliberately
 *  excludes anything still active — a confirmed or pending_payment
 *  booking shouldn't be hideable, since that would let a guest lose
 *  track of a stay they still need to act on. */
const ARCHIVABLE_STATUSES = ["cancelled", "completed", "refunded"];

/**
 * FOUND AND FIXED before this batch could safely proceed: this query
 * previously LEFT JOINed a `property_images` table that does not exist
 * in any tracked migration (confirmed by inspection — it only existed as
 * an orphaned leftover in this sandbox's local Postgres from earlier,
 * unrelated experimentation, never part of the real committed schema).
 * Against the real production database, this function would have thrown
 * a raw SQL error ("relation property_images does not exist") the
 * instant any guest with a booking called it — a real, pre-existing
 * defect, simply never triggered before now because no frontend ever
 * called GET /api/bookings until this batch builds My Trips on top of
 * it. Fixed by removing the reference rather than adding a migration:
 * per this batch's explicit database boundary, a schema addition for a
 * table that was never legitimately part of this project isn't
 * justified just to keep an image field that returns null everywhere
 * anyway (there is no real image pipeline yet, confirmed in Batch 2).
 * propertyImage stays in the returned shape as always-null for now,
 * so the frontend doesn't need to change when a real pipeline exists.
 */
export async function listBookingsForGuest(guestId: string, includeArchived = false) {
  const result = await db.query(
    `SELECT
       b.id, b.property_id, b.check_in, b.check_out, b.guests, b.status, b.archived_at, b.created_at,
       b.payment_flow_version, b.scheduled_charge_date, b.grace_period_started_at,
       (b.stripe_payment_method_id IS NOT NULL) AS has_payment_method,
       p.name AS property_name, p.city, p.district, p.slug,
       bpc.guest_total_minor, bpc.currency,
       pay.status AS payment_status,
       latest_attempt.status AS latest_attempt_status
     FROM bookings b
     JOIN properties p ON p.id = b.property_id
     LEFT JOIN booking_price_components bpc ON bpc.booking_id = b.id
     LEFT JOIN payments pay ON pay.booking_id = b.id
     LEFT JOIN LATERAL (
       SELECT status
       FROM payment_attempts
       WHERE booking_id = b.id
       ORDER BY attempt_number DESC
       LIMIT 1
     ) latest_attempt ON TRUE
     WHERE b.guest_id = $1 ${includeArchived ? "" : "AND b.archived_at IS NULL"}
     ORDER BY b.check_in DESC`,
    [guestId]
  );
  return result.rows.map(mapTripRow);
}

export async function getBookingDetail(bookingId: string) {
  const result = await db.query(
    `SELECT
       b.*, p.name AS property_name, p.city, p.district, p.country_code, p.check_in_time, p.check_out_time, p.house_rules,
       bpc.currency, bpc.accommodation_minor, bpc.cleaning_minor, bpc.guest_service_fee_minor, bpc.taxes_minor,
       bpc.guest_total_minor, bpc.host_payout_minor,
       pay.status AS payment_status, pay.provider_payment_intent_id,
       hp.display_name AS host_name,
       (b.stripe_payment_method_id IS NOT NULL) AS has_payment_method
     FROM bookings b
     JOIN properties p ON p.id = b.property_id
     LEFT JOIN booking_price_components bpc ON bpc.booking_id = b.id
     LEFT JOIN payments pay ON pay.booking_id = b.id
     LEFT JOIN host_profiles hp ON hp.id = b.host_id
     WHERE b.id = $1`,
    [bookingId]
  );
  if (result.rows.length === 0) throw new BookingError("BOOKING_NOT_FOUND", "Booking does not exist");

  // Only queried for new-flow bookings — legacy bookings never have any
  // payment_attempts rows at all (they use the legacy `payments` table
  // exclusively), so this stays empty/harmless for them.
  let latestAttempt: { status: string; failure_code: string | null; failure_message: string | null; created_at: string } | null = null;
  if (result.rows[0].payment_flow_version === "separate_charges_delayed_v1") {
    const attemptRow = await db.query(
      `SELECT status, failure_code, failure_message, created_at FROM payment_attempts WHERE booking_id = $1 ORDER BY attempt_number DESC LIMIT 1`,
      [bookingId]
    );
    latestAttempt = attemptRow.rows[0] ?? null;
  }

  const refunds = await db.query(
    `SELECT amount_minor, currency, reason, status, created_at FROM refunds WHERE booking_id = $1 ORDER BY created_at DESC`,
    [bookingId]
  );

  return { ...mapDetailRow(result.rows[0], latestAttempt), refunds: refunds.rows };
}

/**
 * §5 of this brief, verbatim: "Do not permanently delete the underlying
 * booking/payment record... instead remove the booking from the
 * customer's visible trip history while retaining the underlying record."
 * This function only ever sets archived_at — there is no delete path for
 * a booking anywhere in this codebase, by design.
 */
export async function archiveBooking(bookingId: string, guestId: string) {
  const result = await db.query(
    `UPDATE bookings SET archived_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND guest_id = $2 AND status = ANY($3) AND archived_at IS NULL
     RETURNING id, status`,
    [bookingId, guestId, ARCHIVABLE_STATUSES]
  );
  if (result.rows.length === 0) {
    // Distinguish "doesn't exist / not yours" from "exists but not
    // eligible yet" so the frontend can show the right message rather
    // than a generic failure.
    const exists = await db.query(`SELECT status, archived_at FROM bookings WHERE id = $1 AND guest_id = $2`, [bookingId, guestId]);
    if (exists.rows.length === 0) throw new BookingError("BOOKING_NOT_FOUND", "Booking does not exist");
    if (exists.rows[0].archived_at) throw new BookingError("ALREADY_ARCHIVED", "This booking has already been removed from your trip history");
    throw new BookingError("NOT_ARCHIVABLE", `Bookings with status '${exists.rows[0].status}' can't be removed from your trip history yet`);
  }
  return { bookingId, archived: true };
}

function mapTripRow(row: any) {
  const isNewFlow = row.payment_flow_version === "separate_charges_delayed_v1";
  const scheduledChargeDate = row.scheduled_charge_date ? new Date(row.scheduled_charge_date) : null;
  const gracePeriodExpiresAt = row.grace_period_started_at
    ? new Date(new Date(row.grace_period_started_at).getTime() + GRACE_PERIOD_HOURS * 3600 * 1000)
    : null;
  const guestPaymentStatus = isNewFlow
    ? deriveGuestPaymentStatus({
        hasPaymentMethod: !!row.has_payment_method,
        scheduledChargeDate,
        latestAttemptStatus: row.latest_attempt_status ?? null,
        hasSucceeded: row.status === "confirmed",
        gracePeriodExpiresAt,
        bookingCancelledForNonpayment: row.status === "cancelled" && !row.latest_attempt_status,
      })
    : null;

  return {
    id: row.id,
    propertyId: row.property_id,
    propertyName: row.property_name,
    propertySlug: row.slug,
    propertyImage: null, // no image pipeline exists yet — see this function's doc comment
    city: row.city,
    district: row.district,
    checkIn: row.check_in,
    checkOut: row.check_out,
    guests: row.guests,
    status: row.status,
    paymentStatus: row.payment_status,
    paymentFlowVersion: row.payment_flow_version,
    guestPaymentStatus,
    totalMinor: row.guest_total_minor,
    currency: row.currency,
    archived: row.archived_at != null,
    createdAt: row.created_at,
  };
}

function mapDetailRow(row: any, latestAttempt: { status: string; failure_code: string | null; failure_message: string | null; created_at: string } | null = null) {
  const isNewFlow = row.payment_flow_version === "separate_charges_delayed_v1";
  // Reads the value persisted once, at booking creation (migration 012 +
  // createBooking.ts) — no longer recomputed here on every read, which
  // is exactly the same "decided once" principle just applied to
  // findBookingsDueForScheduledCharge()'s own fix.
  const scheduledChargeDate: Date | null = isNewFlow && row.scheduled_charge_date ? new Date(row.scheduled_charge_date) : null;

  // A safe, server-derived guest-facing payment status for new-flow
  // bookings — reuses lib/payments/scheduledCharges.ts's own
  // deriveGuestPaymentStatus(), the same function used by the corrected
  // ordering fix. Deliberately built from a boolean
  // (stripe_payment_method_id IS NOT NULL) and attempt status/timing
  // only — the actual Stripe Customer/PaymentMethod/SetupIntent/
  // PaymentIntent identifiers are never selected into this object at
  // all, confirmed by direct review of every field listed below.
  let guestPaymentStatus: string | null = null;
  let paymentRecovery: { failureCode: string | null; failureMessage: string | null; nextRetryAt: string | null; gracePeriodExpiresAt: string | null } | null = null;
  if (isNewFlow) {
    const gracePeriodExpiresAt = row.grace_period_started_at
      ? new Date(new Date(row.grace_period_started_at).getTime() + GRACE_PERIOD_HOURS * 3600 * 1000)
      : null;
    guestPaymentStatus = deriveGuestPaymentStatus({
      hasPaymentMethod: !!row.has_payment_method,
      scheduledChargeDate,
      latestAttemptStatus: latestAttempt?.status ?? null,
      hasSucceeded: row.status === "confirmed",
      gracePeriodExpiresAt,
      bookingCancelledForNonpayment: row.status === "cancelled" && !latestAttempt,
    });
    if (latestAttempt?.status === "failed" && row.grace_period_started_at) {
      paymentRecovery = {
        failureCode: latestAttempt.failure_code,
        failureMessage: latestAttempt.failure_message,
        nextRetryAt: row.next_retry_at ? new Date(row.next_retry_at).toISOString() : null,
        gracePeriodExpiresAt: gracePeriodExpiresAt ? gracePeriodExpiresAt.toISOString() : null,
      };
    }
  }

  return {
    id: row.id,
    propertyId: row.property_id,
    propertyName: row.property_name,
    city: row.city,
    district: row.district,
    countryCode: row.country_code,
    hostName: row.host_name,
    paymentFlowVersion: row.payment_flow_version,
    scheduledChargeDate: scheduledChargeDate ? scheduledChargeDate.toISOString() : null,
    guestPaymentStatus,
    paymentRecovery,
    checkIn: row.check_in,
    checkOut: row.check_out,
    checkInTime: row.check_in_time,
    checkOutTime: row.check_out_time,
    houseRules: row.house_rules,
    guests: row.guests,
    status: row.status,
    paymentStatus: row.payment_status,
    breakdown: {
      currency: row.currency,
      accommodationMinor: row.accommodation_minor,
      cleaningMinor: row.cleaning_minor,
      guestServiceFeeMinor: row.guest_service_fee_minor,
      taxesMinor: row.taxes_minor,
      guestTotalMinor: row.guest_total_minor,
    },
    // Batch 3 extension: already selected via `b.*` above, just never
    // included in the mapped response before now — zero query change.
    // Real cancellation tiers, the exact same data cancelBooking.ts
    // itself reads to compute a real cancellation, not a description
    // invented for display purposes.
    cancellationPolicyTiers: row.cancellation_policy_snapshot,
    archived: row.archived_at != null,
    createdAt: row.created_at,
  };
}
