import { db, withTransaction } from "../db";
import { hashToBigint } from "../utils/advisoryLock";
import { isCancellationHostSettlementReconciliationEnabled } from "../config/featureFlags";
import { cancellationSettlementEligibility } from "./cancellationSettlementEligibility";
import {
  findCancellationSettlementTransfer, verifyCancellationSettlementTransfer,
} from "./cancellationSettlementEvidence";

function recoverable(s: any) {
  return s.status === "reconciliation_required" &&
    s.provider_transfer_id === null && s.execution_token !== null &&
    s.execution_started_at !== null && s.execution_lease_expires_at === null;
}
function unchanged(a: any, b: any) {
  const keys = ["id", "booking_id", "entitlement_id", "host_id", "payment_attempt_id",
    "cancellation_audit_id", "refund_id", "original_host_amount_minor", "amount_minor",
    "guest_total_minor", "refund_amount_minor", "currency", "idempotency_key",
    "provider_payment_intent_id", "stripe_connect_account_id", "execution_token"];
  const snapshots = [
    "settlement_snapshot", "booking_snapshot", "entitlement_snapshot",
    "payment_snapshot", "price_snapshot", "audit_snapshot",
    "destination_snapshot", "refund_snapshot"
  ];
  return snapshots.every(key => JSON.stringify(a[key]) === JSON.stringify(b[key])) &&
    keys.every(key => a[key] === b[key]) &&
    new Date(a.execution_started_at).getTime() === new Date(b.execution_started_at).getTime() &&
    new Date(a.scheduled_release_at).getTime() === new Date(b.scheduled_release_at).getTime();
}

/** Records verified existing movement only. Absence cannot authorise replay. */
export async function reconcileCancellationHostSettlement(
  settlementId: string
): Promise<{ recorded: boolean; reason: string }> {
  if (!isCancellationHostSettlementReconciliationEnabled()) {
    return { recorded: false, reason: "Settlement reconciliation is disabled" };
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(settlementId)) {
    return { recorded: false, reason: "Invalid settlement identifier" };
  }
  let initial: any;
  try {
    initial = await cancellationSettlementEligibility(db, settlementId, false, false);
  } catch {
    return { recorded: false, reason: "Settlement evidence requires separate review" };
  }
  if (!recoverable(initial)) {
    return { recorded: false, reason: "Settlement is not eligible for recovery" };
  }
  const expected = {
    settlementId, bookingId: initial.booking_id, entitlementId: initial.entitlement_id,
    amountMinor: initial.amount_minor, currency: String(initial.currency).trim(),
    destination: initial.stripe_connect_account_id,
  };
  const lookup = await findCancellationSettlementTransfer(expected);
  if (lookup.outcome !== "found") {
    return { recorded: false, reason: "Existing transfer not conclusively identified" };
  }
  const verification = await verifyCancellationSettlementTransfer(lookup.transferId, expected);
  if (!verification.verified) return { recorded: false, reason: verification.reason };

  const recorded = await withTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [hashToBigint(initial.booking_id)]);
    await client.query("SELECT id FROM bookings WHERE id = $1 FOR UPDATE", [initial.booking_id]);
    await client.query("SELECT booking_id FROM booking_price_components WHERE booking_id = $1 FOR SHARE", [initial.booking_id]);
    await client.query("SELECT id FROM payment_attempts WHERE booking_id = $1 ORDER BY attempt_number FOR SHARE", [initial.booking_id]);
    await client.query("SELECT id FROM host_transfer_entitlements WHERE id = $1 FOR UPDATE", [initial.entitlement_id]);
    await client.query("SELECT id FROM cancellation_host_settlements WHERE id = $1 FOR UPDATE", [settlementId]);
    await client.query("SELECT id FROM new_flow_refunds WHERE booking_id = $1 ORDER BY id FOR SHARE", [initial.booking_id]);
    await client.query("SELECT id FROM audit_log WHERE id = $1 FOR SHARE NOWAIT", [initial.cancellation_audit_id]);
    await client.query("SELECT id FROM host_profiles WHERE id = $1 FOR SHARE", [initial.host_id]);
    let current: any;
    try {
      current = await cancellationSettlementEligibility(client, settlementId, false, false);
    } catch {
      return false;
    }
    if (!recoverable(current) || !unchanged(initial, current)) return false;
    const duplicate = await client.query(
      `SELECT 1 FROM host_transfer_entitlements WHERE provider_transfer_id = $1
       UNION ALL
       SELECT 1 FROM cancellation_host_settlements
       WHERE provider_transfer_id = $1 AND id <> $2`,
      [lookup.transferId, settlementId]
    );
    if (duplicate.rows.length) return false;
    if (!isCancellationHostSettlementReconciliationEnabled()) return false;
    const result = await client.query(
      `UPDATE cancellation_host_settlements
       SET status = 'succeeded', provider_transfer_id = $3,
           execution_token = NULL, execution_lease_expires_at = NULL,
           last_error = NULL, updated_at = NOW()
       WHERE id = $1 AND status = 'reconciliation_required'
         AND execution_token = $2 AND execution_lease_expires_at IS NULL
         AND execution_started_at IS NOT NULL AND provider_transfer_id IS NULL
       RETURNING id`,
      [settlementId, initial.execution_token, lookup.transferId]
    );
    if (result.rowCount !== 1) return false;
    await client.query(
      `INSERT INTO audit_log(action, object_type, object_id, previous_state, new_state)
       VALUES ('cancellation_host_settlement_reconciled', 'cancellation_host_settlement',
               $1, $2::jsonb, $3::jsonb)`,
      [settlementId, JSON.stringify({ status: "reconciliation_required" }),
       JSON.stringify({ status: "succeeded", bookingId: initial.booking_id,
         entitlementId: initial.entitlement_id, amountMinor: initial.amount_minor,
         currency: expected.currency, providerTransferId: lookup.transferId })]
    );
    return true;
  });
  return {
    recorded,
    reason: recorded ? "Verified existing retained payout reconciled" : "Settlement snapshot changed or transfer already attributed",
  };
}

/** Expiry flags uncertainty only; it never resets a settlement to pending. */
export async function flagExpiredCancellationHostSettlements(limit = 100): Promise<string[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Invalid settlement expiry batch limit");
  }
  if (!isCancellationHostSettlementReconciliationEnabled()) return [];
  return withTransaction(async client => {
    const result = await client.query(
      `WITH expired AS (
         SELECT id FROM cancellation_host_settlements
         WHERE status = 'processing' AND provider_transfer_id IS NULL
           AND execution_token IS NOT NULL AND execution_started_at IS NOT NULL
           AND execution_lease_expires_at < clock_timestamp()
         ORDER BY execution_lease_expires_at, id
         LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE cancellation_host_settlements s
       SET status = 'reconciliation_required', execution_lease_expires_at = NULL,
           last_error = 'Execution lease expired; transfer outcome requires reconciliation',
           updated_at = NOW()
       FROM expired WHERE s.id = expired.id RETURNING s.id`, [limit]
    );
    return result.rows.map(row => String(row.id));
  });
}
