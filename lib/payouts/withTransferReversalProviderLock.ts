import { withTransaction } from "../db";
import { hashToBigint } from "../utils/advisoryLock";

export function reversalFinancialEligibility(a: number, k: number, t: number, c: number, d: number) {
  return `
    AND amount_minor = $${a} AND amount_minor > 0
    AND idempotency_key = $${k}
    AND reason IN ('refund', 'dispute')
    AND EXISTS (
      SELECT 1 FROM host_transfer_entitlements e
      JOIN bookings b ON b.id = e.booking_id
      JOIN booking_price_components pc ON pc.booking_id = b.id
      JOIN payment_attempts p ON p.booking_id = b.id
      JOIN host_profiles hp ON hp.id = e.host_id
      WHERE e.id = host_transfer_reversals.entitlement_id
        AND e.status = 'transfer_created'
        AND e.provider_transfer_id = $${t}
        AND e.provider_transfer_id ~ '^tr_[A-Za-z0-9_]+$'
        AND e.currency = $${c}
        AND hp.stripe_connect_account_id = $${d}
        AND hp.stripe_connect_account_id ~ '^acct_[A-Za-z0-9_]+$'
        AND UPPER(TRIM(e.currency)) ~ '^[A-Z]{3}$'
        AND e.amount_minor > 0
        AND host_transfer_reversals.amount_minor <= e.amount_minor
        AND b.host_id = e.host_id
        AND b.payment_flow_version = 'separate_charges_delayed_v1'
        AND b.status = 'cancelled'
        AND host_transfer_reversals.reason = 'refund'
        AND (SELECT COUNT(*) FROM new_flow_refunds f WHERE f.booking_id = b.id) = 1
        AND EXISTS (
          SELECT 1 FROM new_flow_refunds f
          JOIN audit_log audit ON audit.object_id = b.id
          WHERE f.booking_id = b.id AND f.payment_attempt_id = p.id
            AND f.amount_minor > 0 AND f.amount_minor <= pc.guest_total_minor
            AND UPPER(TRIM(f.currency)) = UPPER(TRIM(pc.currency))
            AND f.status IN ('pending', 'processing', 'succeeded')
            AND audit.action = 'booking_cancelled' AND audit.object_type = 'booking'
            AND audit.previous_state->>'status' = 'confirmed'
            AND audit.new_state->>'status' = 'cancelled'
            AND audit.new_state->>'cancellationKind' = 'paid'
            AND audit.new_state->>'paymentFlowVersion' = 'separate_charges_delayed_v1'
            AND audit.new_state->>'cancelledBy' IN ('guest', 'host', 'admin', 'system')
            AND f.initiated_by = audit.new_state->>'cancelledBy'
            AND f.reason = (audit.new_state->>'cancelledBy') || '_cancellation'
            AND audit.new_state->>'entitlementId' = e.id::text
            AND audit.new_state->>'reversalId' = host_transfer_reversals.id::text
            AND audit.new_state->>'refundId' = f.id::text
            AND audit.new_state->'settlementId' = 'null'::jsonb
            AND audit.new_state->'retainedPayoutSettlementRequired' = 'false'::jsonb
            AND audit.new_state->'refundableMinor' = to_jsonb(f.amount_minor)
            AND EXISTS (
              SELECT 1 FROM generate_series(1, 100) percent
              WHERE audit.new_state->'refundPercent' = to_jsonb(percent)
                AND f.amount_minor = ROUND(pc.guest_total_minor::numeric * percent / 100)
                AND audit.new_state->'hostRetainedMinor' =
                    to_jsonb(ROUND(e.amount_minor::numeric * (100 - percent) / 100)::int)
                AND host_transfer_reversals.amount_minor =
                    e.amount_minor - ROUND(e.amount_minor::numeric * (100 - percent) / 100)
            )
        )
        AND p.status = 'succeeded'
        AND p.provider_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'
        AND p.amount_minor = pc.guest_total_minor AND pc.guest_total_minor > 0
        AND e.amount_minor = pc.host_payout_minor
        AND UPPER(TRIM(p.currency)) = UPPER(TRIM(pc.currency))
        AND UPPER(TRIM(e.currency)) = UPPER(TRIM(pc.currency))
        AND (SELECT COUNT(*) FROM payment_attempts other WHERE other.booking_id = b.id) = 1
        AND (SELECT COUNT(*) FROM host_transfer_reversals other WHERE other.entitlement_id = e.id) = 1
        AND NOT EXISTS (SELECT 1 FROM cancellation_host_settlements s WHERE s.entitlement_id = e.id)
        AND NOT EXISTS (SELECT 1 FROM payments lp WHERE lp.booking_id = b.id)
        AND NOT EXISTS (SELECT 1 FROM refunds lf WHERE lf.booking_id = b.id)
        AND NOT EXISTS (SELECT 1 FROM payouts lp WHERE lp.booking_id = b.id)
    )
  `;
}

export type TransferReversalExecutionSnapshot = {
  reversalId: string;
  entitlementId: string;
  bookingId: string;
  hostId: string;
  executionToken: string;
  amountMinor: number;
  originalAmountMinor: number;
  currency: string;
  idempotencyKey: string;
  providerTransferId: string;
  destination: string;
};

/** Holds local financial authorization during one bounded provider request.
 * The separately committed execution claim survives rollback.
 */
export async function withTransferReversalProviderLock<T>(
  expected: TransferReversalExecutionSnapshot,
  execute: () => Promise<T>
): Promise<T> {
  return withTransaction(async client => {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
    await client.query("SELECT pg_advisory_xact_lock($1)", [hashToBigint(expected.bookingId)]);
    await client.query("SELECT id FROM bookings WHERE id = $1 FOR UPDATE", [expected.bookingId]);
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
      "SELECT id FROM host_transfer_reversals WHERE entitlement_id = $1 ORDER BY id FOR UPDATE",
      [expected.entitlementId]
    );
    await client.query(
      "SELECT id FROM new_flow_refunds WHERE booking_id = $1 ORDER BY id FOR SHARE",
      [expected.bookingId]
    );
    await client.query(
      "SELECT id FROM audit_log WHERE object_id = $1 ORDER BY id FOR SHARE NOWAIT",
      [expected.bookingId]
    );
    await client.query("SELECT id FROM host_profiles WHERE id = $1 FOR SHARE", [expected.hostId]);
    const eligible = await client.query(
      `SELECT id FROM host_transfer_reversals
       WHERE id = $1 AND status = 'reversal_processing'
         AND execution_token = $2 AND provider_reversal_id IS NULL
         AND execution_lease_expires_at > clock_timestamp()
         AND entitlement_id = $8
         AND EXISTS (
           SELECT 1 FROM host_transfer_entitlements e
           WHERE e.id = host_transfer_reversals.entitlement_id
             AND e.booking_id = $9 AND e.host_id = $10
             AND e.amount_minor = $11
         )
         ${reversalFinancialEligibility(3, 4, 5, 6, 7)}`,
      [expected.reversalId, expected.executionToken, expected.amountMinor,
       expected.idempotencyKey, expected.providerTransferId, expected.currency,
       expected.destination, expected.entitlementId, expected.bookingId,
       expected.hostId, expected.originalAmountMinor]
    );
    if (eligible.rowCount !== 1 ||
        !Number.isSafeInteger(expected.amountMinor) || expected.amountMinor <= 0 ||
        !Number.isSafeInteger(expected.originalAmountMinor) ||
        expected.originalAmountMinor < expected.amountMinor ||
        !/^[A-Za-z]{3}$/.test(expected.currency.trim()) ||
        !/^tr_[A-Za-z0-9_]+$/.test(expected.providerTransferId) ||
        !/^acct_[A-Za-z0-9_]+$/.test(expected.destination)) {
      throw new Error("Reversal execution snapshot changed; provider creation blocked");
    }
    return execute();
  });
}
