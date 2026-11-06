import { withTransaction } from "../db";
import { hashToBigint } from "../utils/advisoryLock";
import { cancellationSettlementEligibility } from "./cancellationSettlementEligibility";

export function sameReservation(a: any, b: any) {
  const keys = ["id", "booking_id", "entitlement_id", "host_id", "payment_attempt_id",
    "cancellation_audit_id", "refund_id", "original_host_amount_minor", "amount_minor",
    "guest_total_minor", "refund_amount_minor", "currency", "idempotency_key",
    "provider_payment_intent_id", "stripe_connect_account_id"];
  return keys.every(key => a[key] === b[key]) &&
    new Date(a.scheduled_release_at).getTime() === new Date(b.scheduled_release_at).getTime();
}

/** Holds retained-payout authorization during one bounded provider request.
 * The separately committed execution claim survives rollback.
 */
export async function withCancellationSettlementProviderLock<T>(
  expected: Awaited<ReturnType<typeof cancellationSettlementEligibility>>,
  executionToken: string,
  execute: () => Promise<T>
): Promise<T> {
  return withTransaction(async client => {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
    await client.query("SELECT pg_advisory_xact_lock($1)", [hashToBigint(expected.booking_id)]);
    await client.query("SELECT id FROM bookings WHERE id = $1 FOR UPDATE", [expected.booking_id]);
    await client.query(
      "SELECT booking_id FROM booking_price_components WHERE booking_id = $1 FOR SHARE",
      [expected.booking_id]
    );
    await client.query(
      "SELECT id FROM payment_attempts WHERE booking_id = $1 ORDER BY attempt_number FOR SHARE",
      [expected.booking_id]
    );
    await client.query(
      "SELECT id FROM host_transfer_entitlements WHERE id = $1 FOR UPDATE",
      [expected.entitlement_id]
    );
    await client.query(
      "SELECT id FROM cancellation_host_settlements WHERE id = $1 FOR UPDATE",
      [expected.id]
    );
    await client.query(
      "SELECT id FROM new_flow_refunds WHERE booking_id = $1 ORDER BY id FOR SHARE",
      [expected.booking_id]
    );
    await client.query(
      "SELECT id FROM audit_log WHERE id = $1 FOR SHARE NOWAIT",
      [expected.cancellation_audit_id]
    );
    await client.query("SELECT id FROM host_profiles WHERE id = $1 FOR SHARE", [expected.host_id]);
    const current = await cancellationSettlementEligibility(client, expected.id);
    const active = await client.query(
      `SELECT id FROM cancellation_host_settlements
       WHERE id = $1 AND status = 'processing' AND execution_token = $2
         AND provider_transfer_id IS NULL
         AND execution_lease_expires_at > clock_timestamp()`,
      [expected.id, executionToken]
    );
    if (active.rowCount !== 1 || !sameReservation(expected, current)) {
      throw new Error("Settlement execution ownership or reservation changed");
    }
    return execute();
  });
}
