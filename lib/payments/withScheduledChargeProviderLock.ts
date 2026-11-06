import { withTransaction } from "../db";
import { hashToBigint } from "../utils/advisoryLock";

export type ScheduledChargeExecutionSnapshot = {
  bookingId: string;
  attemptId: string;
  claimToken: string;
  customerId: string;
  paymentMethodId: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
};

/** Holds financial row locks while one bounded provider request settles.
 * The execution claim was committed separately and survives rollback.
 * This helper never creates, reclaims or clears an execution claim.
 */
export async function withScheduledChargeProviderLock<T>(
  expected: ScheduledChargeExecutionSnapshot,
  execute: () => Promise<T>
): Promise<T> {
  return withTransaction(async client => {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
    await client.query("SELECT pg_advisory_xact_lock($1)", [hashToBigint(expected.bookingId)]);
    const booking = (await client.query(
      "SELECT *, (hold_expires_at IS NULL OR hold_expires_at > clock_timestamp()) AS hold_active FROM bookings WHERE id = $1 FOR UPDATE", [expected.bookingId]
    )).rows[0];
    const prices = await client.query(
      "SELECT guest_total_minor, currency FROM booking_price_components WHERE booking_id = $1 FOR SHARE",
      [expected.bookingId]
    );
    const attempts = await client.query(
      "SELECT *, lease_expires_at > clock_timestamp() AS lease_active FROM payment_attempts WHERE booking_id = $1 ORDER BY attempt_number FOR UPDATE",
      [expected.bookingId]
    );
    const price = prices.rows[0];
    const attempt = attempts.rows[0];
    if (!booking || booking.status !== "pending_payment" ||
        booking.payment_flow_version !== "separate_charges_delayed_v1" ||
        booking.tax_treatment === "unconfigured" ||
        booking.archived_at !== null ||
        booking.stripe_customer_id !== expected.customerId ||
        booking.stripe_payment_method_id !== expected.paymentMethodId ||
        booking.hold_active !== true ||
        prices.rows.length !== 1 ||
        price.guest_total_minor !== expected.amountMinor ||
        String(price.currency).trim().toUpperCase() !== expected.currency.toUpperCase() ||
        attempts.rows.length !== 1 ||
        attempt.id !== expected.attemptId ||
        attempt.status !== "pending" ||
        attempt.claim_token !== expected.claimToken ||
        attempt.lease_active !== true ||
        attempt.provider_payment_intent_id !== null ||
        attempt.amount_minor !== expected.amountMinor ||
        String(attempt.currency).trim().toUpperCase() !== expected.currency.toUpperCase() ||
        attempt.idempotency_key !== expected.idempotencyKey) {
      throw new Error("Charge execution snapshot changed; provider creation blocked");
    }
    const unresolvedSetup = await client.query(
      `SELECT r.id FROM audit_log r
         WHERE r.object_id = $1 AND r.object_type = 'booking'
           AND r.action = 'setup_intent_creation_reserved'
           AND NOT EXISTS (
             SELECT 1 FROM audit_log c
             WHERE c.object_id = r.object_id AND c.object_type = 'booking'
               AND c.action = 'setup_intent_creation_completed'
               AND c.new_state->>'creationId' = r.id::text
           ) LIMIT 1`, [expected.bookingId]
    );
    if (unresolvedSetup.rows.length) {
      throw new Error("Unresolved SetupIntent creation reservation requires review; charging blocked");
    }
    return execute();
  });
}
