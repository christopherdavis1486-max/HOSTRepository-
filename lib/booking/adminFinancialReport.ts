import { db } from "../db";
import { getBookingDetail } from "./tripHistory";
import { getHostBookingDetail } from "./hostBookings";

/** Caller must enforce bookings/refunds/payouts read permissions.
 * Local reporting only. Separate reads may observe concurrent changes.
 */
export async function getAdminFinancialReport(bookingId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bookingId)) {
    throw new Error("Invalid booking identifier");
  }
  const exists = await db.query("SELECT id FROM bookings WHERE id = $1", [bookingId]);
  if (exists.rows.length !== 1) return null;
  const [booking, host, attempts, transfers, settlements, reversals] = await Promise.all([
    getBookingDetail(bookingId),
    getHostBookingDetail(bookingId),
    db.query(
      `SELECT attempt_number, status, amount_minor, currency, created_at,
         claim_token IS NOT NULL AS execution_claim_recorded,
         lease_expires_at > clock_timestamp() AS lease_active
       FROM payment_attempts WHERE booking_id = $1 ORDER BY attempt_number`, [bookingId]
    ),
    db.query(
      `SELECT status, amount_minor, currency, scheduled_release_at,
         provider_transfer_id IS NOT NULL AS provider_reference_recorded,
         execution_started_at IS NOT NULL AS execution_started,
         execution_lease_expires_at > clock_timestamp() AS lease_active
       FROM host_transfer_entitlements WHERE booking_id = $1 ORDER BY id`, [bookingId]
    ),
    db.query(
      `SELECT status, amount_minor, currency, scheduled_release_at,
         provider_transfer_id IS NOT NULL AS provider_reference_recorded
       FROM cancellation_host_settlements WHERE booking_id = $1 ORDER BY id`, [bookingId]
    ),
    db.query(
      `SELECT r.status, r.amount_minor, e.currency,
         r.provider_reversal_id IS NOT NULL AS provider_reference_recorded
       FROM host_transfer_reversals r JOIN host_transfer_entitlements e ON e.id = r.entitlement_id
       WHERE e.booking_id = $1 ORDER BY r.id`, [bookingId]
    ),
  ]);
  const setupReviews = await db.query(
    `SELECT id, created_at,
       CASE WHEN new_state->>'phase' = 'payment_method_save'
         THEN 'payment_method_save'
         WHEN new_state->>'phase' = 'immediate_charge'
         THEN 'immediate_charge' ELSE 'unknown' END AS phase
     FROM audit_log
     WHERE object_type = 'booking' AND object_id = $1
       AND action = 'setup_webhook_review_required'
     ORDER BY created_at DESC, id DESC LIMIT 51`,
    [bookingId]
  );
  const setupReviewHistory = {
    records: setupReviews.rows.slice(0, 50).map(row => ({
      id: row.id as string,
      recordedAt: new Date(row.created_at).toISOString(),
      phase: row.phase as "payment_method_save" | "immediate_charge" | "unknown",
    })),
    hasMore: setupReviews.rows.length > 50,
  };


  const skippedReferences = await db.query(
    `SELECT id, created_at,
       CASE WHEN new_state->>'reason' = 'historical_reference_not_current'
         THEN 'historical_reference_not_current' ELSE 'unknown' END AS reason
     FROM audit_log
     WHERE object_type = 'booking' AND object_id = $1
       AND action = 'setup_webhook_reference_skipped'
     ORDER BY created_at DESC, id DESC LIMIT 51`,
    [bookingId]
  );
  const skippedSetupReferenceHistory = {
    records: skippedReferences.rows.slice(0, 50).map(row => ({
      id: row.id as string,
      recordedAt: new Date(row.created_at).toISOString(),
      reason: row.reason as "historical_reference_not_current" | "unknown",
    })),
    hasMore: skippedReferences.rows.length > 50,
  };

  return {
    skippedSetupReferenceHistory,
    setupReviewHistory,
    bookingId, paymentFlowVersion: booking.paymentFlowVersion,
    bookingStatus: booking.status,
    paymentStatus: booking.paymentFlowVersion === "separate_charges_delayed_v1"
      ? booking.guestPaymentStatus : booking.paymentStatus,
    breakdown: host?.breakdown ?? booking.breakdown,
    refunds: booking.refunds,
    payoutDisplayLabel: host?.payoutDisplayLabel ?? null,
    legacyPayoutStatus: host?.payoutStatus ?? null,
    paymentAttempts: attempts.rows,
    transfers: transfers.rows,
    retainedSettlements: settlements.rows,
    transferReversals: reversals.rows,
    evidenceScope: "Local records; separate reads may reflect concurrent changes. No provider verification performed.",
  };
}
