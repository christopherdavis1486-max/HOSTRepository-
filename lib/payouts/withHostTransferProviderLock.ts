import { withTransaction } from "../db";
import { hashToBigint } from "../utils/advisoryLock";

export function transferFinancialEligibility(a: number, c: number, k: number, d: number) {
  return `
    AND amount_minor = $${a} AND currency = $${c} AND idempotency_key = $${k}
    AND scheduled_release_at <= clock_timestamp()
    AND EXISTS (
      SELECT 1 FROM bookings b
      JOIN booking_price_components pc ON pc.booking_id = b.id
      JOIN host_profiles hp ON hp.id = host_transfer_entitlements.host_id
      JOIN payment_attempts p ON p.booking_id = b.id
      WHERE b.id = host_transfer_entitlements.booking_id
        AND b.host_id = host_transfer_entitlements.host_id
        AND b.status = 'confirmed'
        AND b.payment_flow_version = 'separate_charges_delayed_v1'
        AND hp.payout_account_status = 'active'
        AND hp.stripe_connect_account_id = $${d}
        AND hp.stripe_connect_account_id ~ '^acct_[A-Za-z0-9_]+$'
        AND p.status = 'succeeded'
        AND p.provider_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'
        AND p.amount_minor = pc.guest_total_minor AND pc.guest_total_minor > 0
        AND pc.host_payout_minor = host_transfer_entitlements.amount_minor
        AND pc.host_payout_minor > 0
        AND UPPER(TRIM(pc.currency)) ~ '^[A-Z]{3}$'
        AND UPPER(TRIM(p.currency)) = UPPER(TRIM(pc.currency))
        AND UPPER(TRIM(host_transfer_entitlements.currency)) = UPPER(TRIM(pc.currency))
        AND (SELECT COUNT(*) FROM payment_attempts other WHERE other.booking_id = b.id) = 1
        AND NOT EXISTS (SELECT 1 FROM new_flow_refunds f WHERE f.booking_id = b.id)
        AND NOT EXISTS (SELECT 1 FROM refunds f WHERE f.booking_id = b.id)
        AND NOT EXISTS (SELECT 1 FROM payments lp WHERE lp.booking_id = b.id)
        AND NOT EXISTS (SELECT 1 FROM payouts lp WHERE lp.booking_id = b.id)
        AND NOT EXISTS (SELECT 1 FROM host_transfer_reversals r
                        WHERE r.entitlement_id = host_transfer_entitlements.id)
        AND NOT EXISTS (SELECT 1 FROM cancellation_host_settlements s
                        WHERE s.entitlement_id = host_transfer_entitlements.id)
    )
  `;
}

export type HostTransferExecutionSnapshot = {
  entitlementId: string;
  bookingId: string;
  hostId: string;
  executionToken: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
  destination: string;
};

/** Holds financial rows during one bounded provider request.
 * The separately committed execution claim survives rollback.
 */
export async function withHostTransferProviderLock<T>(
  expected: HostTransferExecutionSnapshot,
  execute: () => Promise<T>
): Promise<T> {
  return withTransaction(async client => {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
    await client.query("SELECT pg_advisory_xact_lock($1)", [hashToBigint(expected.bookingId)]);
    await client.query(
      "SELECT id FROM bookings WHERE id = $1 FOR UPDATE",
      [expected.bookingId]
    );
    await client.query(
      "SELECT booking_id FROM booking_price_components WHERE booking_id = $1 FOR SHARE",
      [expected.bookingId]
    );
    await client.query(
      "SELECT id FROM payment_attempts WHERE booking_id = $1 ORDER BY attempt_number FOR SHARE",
      [expected.bookingId]
    );
    await client.query(
      "SELECT id FROM host_transfer_entitlements WHERE id = $1 FOR UPDATE",
      [expected.entitlementId]
    );
    await client.query(
      "SELECT id FROM host_profiles WHERE id = $1 FOR SHARE",
      [expected.hostId]
    );
    const eligible = await client.query(
      `SELECT id FROM host_transfer_entitlements
       WHERE id = $1 AND status = 'transfer_processing'
         AND execution_token = $2 AND provider_transfer_id IS NULL
         AND execution_lease_expires_at > clock_timestamp()
         AND booking_id = $7 AND host_id = $8
         ${transferFinancialEligibility(3, 4, 5, 6)}`,
      [expected.entitlementId, expected.executionToken, expected.amountMinor,
       expected.currency, expected.idempotencyKey, expected.destination,
       expected.bookingId, expected.hostId]
    );
    if (eligible.rowCount !== 1 ||
        !Number.isSafeInteger(expected.amountMinor) || expected.amountMinor <= 0 ||
        !/^[A-Za-z]{3}$/.test(expected.currency.trim()) ||
        !/^acct_[A-Za-z0-9_]+$/.test(expected.destination)) {
      throw new Error("Transfer execution snapshot changed; provider creation blocked");
    }
    return execute();
  });
}
