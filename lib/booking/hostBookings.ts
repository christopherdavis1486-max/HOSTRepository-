import { db } from "../db";
import { computeGuestPaymentStatus } from "../payments/scheduledCharges";

/**
 * Host-side counterpart to lib/booking/tripHistory.ts's
 * listBookingsForGuest() — same reasoning, same guardrails: no
 * `property_images` reference (that table was found, twice, to not
 * exist in any tracked migration — see tripHistory.ts and
 * savedProperties.ts's own doc comments), no client-side price
 * calculation, every amount comes straight from
 * booking_price_components, already computed authoritatively by the
 * price engine at booking-creation time.
 */
export async function listBookingsForHost(hostProfileId: string) {
  const result = await db.query(
    `SELECT
       b.id, b.property_id, b.check_in, b.check_out, b.guests, b.status, b.guest_name, b.created_at,
       b.payment_flow_version, b.grace_period_started_at, b.scheduled_charge_date,
       (b.stripe_payment_method_id IS NOT NULL) AS has_payment_method,
       p.name AS property_name, p.city, p.district,
       bpc.guest_total_minor, bpc.currency,
       pay.status AS payment_status
     FROM bookings b
     JOIN properties p ON p.id = b.property_id
     LEFT JOIN booking_price_components bpc ON bpc.booking_id = b.id
     LEFT JOIN payments pay ON pay.booking_id = b.id
     WHERE b.host_id = $1
     ORDER BY b.check_in DESC`,
    [hostProfileId]
  );
  return Promise.all(result.rows.map(async (row) => {
    // Same authoritative, new-flow-aware status the guest's own trip
    // list already computes (lib/booking/tripHistory.ts) — reused via
    // the shared helper rather than duplicated here. Returns null for a
    // legacy booking, in which case the existing legacy value is used
    // exactly as before, unchanged.
    const guestPaymentStatus = await computeGuestPaymentStatus(row.id, {
      paymentFlowVersion: row.payment_flow_version,
      hasPaymentMethod: !!row.has_payment_method,
      status: row.status,
      gracePeriodStartedAt: row.grace_period_started_at,
      scheduledChargeDate: row.scheduled_charge_date,
    });
    return {
      id: row.id,
      propertyId: row.property_id,
      propertyName: row.property_name,
      city: row.city,
      district: row.district,
      checkIn: row.check_in,
      checkOut: row.check_out,
      guests: row.guests,
      guestName: row.guest_name, // already legitimately collected for this booking — not a new data exposure
      status: row.status,
      paymentFlowVersion: row.payment_flow_version,
      paymentStatus: row.payment_status,
      guestPaymentStatus,
      totalMinor: row.guest_total_minor,
      currency: row.currency,
    };
  }));
}

/**
 * One booking's full operational detail for its host. Ownership itself
 * is NOT checked here — callers use resolveBookingAccess() first (the
 * same centralized check the guest side already uses), exactly
 * mirroring how getBookingDetail() in tripHistory.ts is also always
 * called after an access check, not instead of one.
 *
 * Financial fields, and exactly where each comes from — stated
 * explicitly because getting this wrong would misrepresent real money:
 *   - guestTotalMinor: what the guest paid — booking_price_components,
 *     the same authoritative row the guest's own trip detail reads.
 *   - hostCommissionMinor / hostPayoutMinor: booking_price_components,
 *     computed once by the price engine at booking time — NOT
 *     recomputed or derived by subtraction here.
 *   - payoutStatus: the REAL payouts.status row for this booking
 *     (scheduled/in_transit/paid/failed/cancelled) — not inferred from
 *     booking or payment status, which would be guessing.
 */
export async function getHostBookingDetail(bookingId: string) {
  const result = await db.query(
    `SELECT
       b.id, b.check_in, b.check_out, b.guests, b.status, b.guest_name, b.guest_email,
       b.payment_flow_version, b.grace_period_started_at, b.scheduled_charge_date,
       (b.stripe_payment_method_id IS NOT NULL) AS has_payment_method,
       p.id AS property_id, p.name AS property_name, p.city, p.district,
       bpc.currency, bpc.accommodation_minor, bpc.cleaning_minor, bpc.guest_service_fee_minor,
       bpc.taxes_minor, bpc.guest_total_minor, bpc.host_commission_minor, bpc.host_payout_minor,
       pay.status AS payment_status,
       po.status AS payout_status,
       hte.status AS entitlement_status
     FROM bookings b
     JOIN properties p ON p.id = b.property_id
     LEFT JOIN booking_price_components bpc ON bpc.booking_id = b.id
     LEFT JOIN payments pay ON pay.booking_id = b.id
     LEFT JOIN payouts po ON po.booking_id = b.id
     LEFT JOIN host_transfer_entitlements hte ON hte.booking_id = b.id
     WHERE b.id = $1`,
    [bookingId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];

  const guestPaymentStatus = await computeGuestPaymentStatus(row.id, {
    paymentFlowVersion: row.payment_flow_version,
    hasPaymentMethod: !!row.has_payment_method,
    status: row.status,
    gracePeriodStartedAt: row.grace_period_started_at,
    scheduledChargeDate: row.scheduled_charge_date,
  });

  return {
    id: row.id,
    propertyId: row.property_id,
    propertyName: row.property_name,
    city: row.city,
    district: row.district,
    checkIn: row.check_in,
    checkOut: row.check_out,
    guests: row.guests,
    guestName: row.guest_name,
    guestEmail: row.guest_email,
    status: row.status,
    paymentFlowVersion: row.payment_flow_version,
    paymentStatus: row.payment_status,
    guestPaymentStatus,
    payoutStatus: row.payout_status,
    entitlementStatus: row.entitlement_status,
    breakdown: row.currency ? {
      currency: row.currency,
      accommodationMinor: row.accommodation_minor,
      cleaningMinor: row.cleaning_minor,
      guestServiceFeeMinor: row.guest_service_fee_minor,
      taxesMinor: row.taxes_minor,
      guestTotalMinor: row.guest_total_minor,
      hostCommissionMinor: row.host_commission_minor,
      hostPayoutMinor: row.host_payout_minor,
    } : null,
  };
}
