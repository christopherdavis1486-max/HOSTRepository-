import { db } from "../db";
import { deriveGuestPaymentStatus, GRACE_PERIOD_HOURS } from "../payments/scheduledCharges";
import { deriveNewFlowRefundDisplay, newFlowRefundDisplaySql } from "../payments/newFlowRefundDisplay";

/** Guest booking financial records scoped to the authenticated user's identifier.
 * Explicit fields exclude provider references, execution tokens and internal errors.
 * Reads local records only; never verifies or executes provider operations.
 */
export async function listBookingFinancialExport(userId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error("Invalid export user identifier");
  }
  const result = await db.query(
    `SELECT b.id, b.check_in, b.check_out, b.status, b.guests, b.created_at,
       b.payment_flow_version, b.scheduled_charge_date, b.grace_period_started_at,
       (b.stripe_payment_method_id IS NOT NULL) AS has_payment_method,
       p.name AS property_name, p.city, pc.currency, pc.guest_total_minor,
       pay.status AS legacy_payment_status,
       ${newFlowRefundDisplaySql} AS refund_evidence,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'status', a.status, 'amount_minor', a.amount_minor,
           'currency', a.currency, 'created_at', a.created_at,
           'attempt_number', a.attempt_number
         ) ORDER BY a.attempt_number DESC)
         FROM payment_attempts a WHERE a.booking_id = b.id
           AND b.payment_flow_version = 'separate_charges_delayed_v1'
       ), '[]'::jsonb) AS attempts,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'amount_minor', r.amount_minor, 'currency', r.currency,
           'reason', r.reason, 'status', r.status, 'created_at', r.created_at
         ) ORDER BY r.created_at DESC, r.id DESC)
         FROM refunds r WHERE r.booking_id = b.id
           AND b.payment_flow_version = 'destination_charge_legacy'
       ), '[]'::jsonb) AS legacy_refunds,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'amount_minor', r.amount_minor, 'currency', r.currency,
           'reason', r.reason, 'created_at', r.created_at
         ) ORDER BY r.id)
         FROM new_flow_refunds r WHERE r.booking_id = b.id
           AND b.payment_flow_version = 'separate_charges_delayed_v1'
       ), '[]'::jsonb) AS refund_records
     FROM bookings b JOIN properties p ON p.id = b.property_id
     LEFT JOIN booking_price_components pc ON pc.booking_id = b.id
     LEFT JOIN payments pay ON pay.booking_id = b.id
     WHERE b.guest_id = $1 ORDER BY b.created_at DESC, b.id DESC`, [userId]
  );
  return result.rows.map(row => {
    const isNew = row.payment_flow_version === "separate_charges_delayed_v1";
    const evidence = row.refund_evidence ?? [];
    const attempts = row.attempts ?? [];
    const paymentStatus = isNew
      ? deriveNewFlowRefundDisplay(evidence) ?? deriveGuestPaymentStatus({
          hasPaymentMethod: row.has_payment_method,
          scheduledChargeDate: row.scheduled_charge_date ? new Date(row.scheduled_charge_date) : null,
          latestAttemptStatus: attempts[0]?.status ?? null,
          hasSucceeded: row.status === "confirmed",
          gracePeriodExpiresAt: row.grace_period_started_at
            ? new Date(new Date(row.grace_period_started_at).getTime() + GRACE_PERIOD_HOURS * 3600000)
            : null,
          bookingCancelledForNonpayment: row.status === "cancelled" && attempts.length === 0,
        })
      : row.legacy_payment_status;
    return {
      id: row.id, check_in: row.check_in, check_out: row.check_out,
      status: row.status, guests: row.guests, created_at: row.created_at,
      property_name: row.property_name, city: row.city,
      currency: row.currency, guest_total_minor: row.guest_total_minor,
      payment_flow_version: row.payment_flow_version,
      payment_status: paymentStatus,
      payment_attempts: isNew ? attempts : [],
      refunds: isNew
        ? row.refund_records.map((r: any, index: number) => ({
            ...r, status: evidence.length > 1
              ? "refund_needs_review" : deriveNewFlowRefundDisplay([evidence[index]]),
          }))
        : row.legacy_refunds,
    };
  });
}
