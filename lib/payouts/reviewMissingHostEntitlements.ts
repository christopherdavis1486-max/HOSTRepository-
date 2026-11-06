import { db } from "../db";

export type MissingHostEntitlementReview = {
  bookingId: string;
  paymentAttemptCount: number;
  successfulPaymentCount: number;
  priceRecordCount: number;
  hasFinancialConflict: boolean;
  reasons: string[];
  automaticRecoveryPermitted: false;
};

/** Bounded local inventory only. Never verifies provider history or authorizes payout.
 * Results describe one database statement's snapshot and may subsequently change.
 */
export async function reviewMissingHostEntitlements(
  limit = 100
): Promise<MissingHostEntitlementReview[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Review limit must be an integer between 1 and 500");
  }
  const result = await db.query(
    `SELECT b.id AS booking_id,
       (SELECT COUNT(*)::int FROM payment_attempts p
        WHERE p.booking_id = b.id) AS attempt_count,
       (SELECT COUNT(*)::int FROM payment_attempts p
        WHERE p.booking_id = b.id AND p.status = 'succeeded') AS succeeded_count,
       (SELECT COUNT(*)::int FROM booking_price_components pc
        WHERE pc.booking_id = b.id) AS price_count,
       (EXISTS (SELECT 1 FROM new_flow_refunds x WHERE x.booking_id = b.id)
        OR EXISTS (SELECT 1 FROM cancellation_host_settlements x WHERE x.booking_id = b.id)
        OR EXISTS (SELECT 1 FROM payments x WHERE x.booking_id = b.id)
        OR EXISTS (SELECT 1 FROM refunds x WHERE x.booking_id = b.id)
        OR EXISTS (SELECT 1 FROM payouts x WHERE x.booking_id = b.id)) AS financial_conflict
     FROM bookings b
     WHERE b.payment_flow_version = 'separate_charges_delayed_v1'
       AND b.status = 'confirmed'
       AND EXISTS (SELECT 1 FROM payment_attempts p
                   WHERE p.booking_id = b.id AND p.status = 'succeeded')
       AND NOT EXISTS (SELECT 1 FROM host_transfer_entitlements e WHERE e.booking_id = b.id)
     ORDER BY b.created_at, b.id
     LIMIT $1`, [limit]
  );
  return result.rows.map(row => {
    const reasons = [
      "Original entitlement identity and prior provider transfers require review",
      "Original release timing requires review",
      "Fresh provider payment verification is required",
    ];
    if (row.attempt_count !== 1 || row.succeeded_count !== 1) {
      reasons.push("Payment attempt ownership is ambiguous");
    }
    if (row.price_count !== 1) reasons.push("Booking price record requires review");
    if (row.financial_conflict) reasons.push("Other financial records require review");
    return {
      bookingId: row.booking_id,
      paymentAttemptCount: row.attempt_count,
      successfulPaymentCount: row.succeeded_count,
      priceRecordCount: row.price_count,
      hasFinancialConflict: row.financial_conflict,
      reasons,
      automaticRecoveryPermitted: false as const,
    };
  });
}
