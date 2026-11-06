import { db } from "../db";

export type InterruptedHostTransferClaimReview = {
  entitlementId: string;
  bookingId: string;
  bookingStatus: string;
  claimedAt: Date | string | null;
  hasWorkerIdentity: boolean;
  paymentAttemptCount: number;
  successfulPaymentCount: number;
  priceRecordCount: number;
  hasFinancialConflict: boolean;
  reasons: string[];
  automaticRecoveryPermitted: false;
};

/**
 * Read-only review candidates, not proof that a worker has stopped.
 * Age never authorizes reclaim, execution, reconciliation or provider writes.
 * Missing claim timestamps use the record's update time for review ordering
 * only; no claim or execution timestamp is invented or stored.
 * One-statement snapshot; records may change immediately afterward.
 */
export async function reviewInterruptedHostTransferClaims(
  limit = 100,
  minimumAgeMinutes = 15
): Promise<InterruptedHostTransferClaimReview[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Invalid interrupted-claim review limit");
  }
  if (!Number.isInteger(minimumAgeMinutes) ||
      minimumAgeMinutes < 1 || minimumAgeMinutes > 10080) {
    throw new Error("Invalid interrupted-claim review age");
  }

  const result = await db.query(
    `SELECT e.id, e.booking_id, b.status AS booking_status, e.claimed_at,
       (NULLIF(TRIM(e.claimed_by_worker_id), '') IS NOT NULL) AS has_worker_identity,
       (SELECT COUNT(*)::int FROM payment_attempts p
        WHERE p.booking_id = b.id) AS attempt_count,
       (SELECT COUNT(*)::int FROM payment_attempts p
        WHERE p.booking_id = b.id AND p.status = 'succeeded') AS succeeded_count,
       (SELECT COUNT(*)::int FROM booking_price_components pc
        WHERE pc.booking_id = b.id) AS price_count,
       (EXISTS (SELECT 1 FROM new_flow_refunds x WHERE x.booking_id = b.id)
        OR EXISTS (SELECT 1 FROM refunds x WHERE x.booking_id = b.id)
        OR EXISTS (SELECT 1 FROM payments x WHERE x.booking_id = b.id)
        OR EXISTS (SELECT 1 FROM payouts x WHERE x.booking_id = b.id)
        OR EXISTS (SELECT 1 FROM cancellation_host_settlements x
                   WHERE x.booking_id = b.id OR x.entitlement_id = e.id)
        OR EXISTS (SELECT 1 FROM host_transfer_reversals x
                   WHERE x.entitlement_id = e.id)) AS financial_conflict
     FROM host_transfer_entitlements e
     JOIN bookings b ON b.id = e.booking_id
     WHERE b.payment_flow_version = 'separate_charges_delayed_v1'
       AND e.status = 'transfer_claimed'
       AND e.provider_transfer_id IS NULL
       AND e.execution_token IS NULL
       AND e.execution_started_at IS NULL
       AND e.execution_lease_expires_at IS NULL
       AND COALESCE(e.claimed_at, e.updated_at) <=
           clock_timestamp() - ($2::int * INTERVAL '1 minute')
     ORDER BY COALESCE(e.claimed_at, e.updated_at), e.id
     LIMIT $1`,
    [limit, minimumAgeMinutes]
  );
  return result.rows.map(row => {
    const reasons = [
      "Worker ownership and liveness require review",
      "Provider transfer history requires verification before any recovery decision",
      "Claim age does not authorize automatic execution or reclaim",
    ];
    if (row.claimed_at === null) reasons.push("Original claim timestamp is missing");
    if (!row.has_worker_identity) reasons.push("Claim worker identity is missing");
    if (row.booking_status !== "confirmed") reasons.push("Booking status requires review");
    if (row.attempt_count !== 1 || row.succeeded_count !== 1) {
      reasons.push("Payment attempt evidence requires review");
    }
    if (row.price_count !== 1) reasons.push("Booking price record requires review");
    if (row.financial_conflict) reasons.push("Other financial records require review");
    return {
      entitlementId: String(row.id),
      bookingId: String(row.booking_id),
      bookingStatus: row.booking_status,
      claimedAt: row.claimed_at,
      hasWorkerIdentity: row.has_worker_identity,
      paymentAttemptCount: row.attempt_count,
      successfulPaymentCount: row.succeeded_count,
      priceRecordCount: row.price_count,
      hasFinancialConflict: row.financial_conflict,
      reasons,
      automaticRecoveryPermitted: false as const,
    };
  });
}
