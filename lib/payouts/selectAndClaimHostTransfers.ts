import { db, withTransaction } from "../db";
import { isHostTransferExecutionEnabled } from "../config/featureFlags";
import { transferFinancialEligibility } from "./withHostTransferProviderLock";

/**
 * Advisory, read-only discovery of unclaimed ordinary transfers.
 * Selection is not authorization. Claims and execution recheck eligibility.
 * Existing claimed/started transfers are never reset or reclaimed here.
 */
export async function selectClaimableHostTransferIds(limit = 25): Promise<string[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("Invalid host transfer selection limit");
  }
  if (!isHostTransferExecutionEnabled()) return [];
  const query = buildClaimableHostTransferSelectionQuery(limit);
  const result = await db.query(query.text, query.values);
  if (!isHostTransferExecutionEnabled()) return [];
  return result.rows.map(row => String(row.id));
}

/**
 * Local first claim only; no provider calls or automatic reclaim.
 * Uses booking-first locking and the execution worker's financial predicate.
 * Execution still independently verifies provider evidence and ownership.
 */
export async function claimSelectedHostTransfer(
  entitlementId: string,
  workerId: string
): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entitlementId) ||
      typeof workerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(workerId)) {
    throw new Error("Invalid host transfer claim identity");
  }
  if (!isHostTransferExecutionEnabled()) return false;

  const reference = (await db.query(
    `SELECT e.booking_id, e.host_id, e.amount_minor, e.currency,
            e.idempotency_key, hp.stripe_connect_account_id
     FROM host_transfer_entitlements e
     JOIN host_profiles hp ON hp.id = e.host_id WHERE e.id = $1`,
    [entitlementId]
  )).rows[0];
  if (!reference) return false;

  return withTransaction(async client => {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SELECT id FROM bookings WHERE id = $1 FOR UPDATE", [reference.booking_id]);
    await client.query(
      "SELECT booking_id FROM booking_price_components WHERE booking_id = $1 FOR SHARE",
      [reference.booking_id]
    );
    await client.query(
      "SELECT id FROM payment_attempts WHERE booking_id = $1 ORDER BY attempt_number FOR SHARE",
      [reference.booking_id]
    );
    await client.query(
      "SELECT id FROM host_transfer_entitlements WHERE id = $1 FOR UPDATE",
      [entitlementId]
    );
    await client.query("SELECT id FROM host_profiles WHERE id = $1 FOR SHARE", [reference.host_id]);
    if (!isHostTransferExecutionEnabled()) return false;

    const result = await client.query(
      `UPDATE host_transfer_entitlements
       SET status = 'transfer_claimed', claimed_at = clock_timestamp(),
           claimed_by_worker_id = $2, updated_at = NOW()
       WHERE id = $1 AND status = 'entitled'
         AND booking_id = $7 AND host_id = $8
         AND claimed_at IS NULL AND claimed_by_worker_id IS NULL
         AND provider_transfer_id IS NULL
         AND execution_token IS NULL AND execution_started_at IS NULL
         AND execution_lease_expires_at IS NULL
         ${transferFinancialEligibility(3, 4, 5, 6)}
       RETURNING id`,
      [entitlementId, workerId, reference.amount_minor, reference.currency,
       reference.idempotency_key, reference.stripe_connect_account_id,
       reference.booking_id, reference.host_id]
    );
    return result.rowCount === 1;
  });
}

/** Advisory discovery SQL; financial claims and workers recheck eligibility. */
export function buildClaimableHostTransferSelectionQuery(
  limit = 25,
  useQueue = false
): { text: string; values: (string | number)[] } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("Invalid host transfer selection limit");
  }
  if (typeof useQueue !== "boolean") {
    throw new Error("Invalid host transfer queue selection option");
  }
  const queueJoin = useQueue
    ? "LEFT JOIN host_transfer_queue_reviews q ON q.entitlement_id = e.id AND q.operation = $2"
    : "";
  const queueDue = useQueue
    ? "AND (q.next_review_at IS NULL OR q.next_review_at <= clock_timestamp())"
    : "";
  const queueOrder = useQueue
    ? "COALESCE(q.next_review_at, e.scheduled_release_at)" : "e.scheduled_release_at";
  return {
    text:
    `SELECT e.id
     FROM host_transfer_entitlements e
     JOIN bookings b ON b.id = e.booking_id AND b.host_id = e.host_id
     JOIN host_profiles hp ON hp.id = e.host_id
     JOIN booking_price_components pc ON pc.booking_id = b.id
     JOIN payment_attempts p ON p.booking_id = b.id
     ${queueJoin}
     WHERE e.status = 'entitled'
       AND e.claimed_at IS NULL AND e.claimed_by_worker_id IS NULL
       AND e.provider_transfer_id IS NULL
       AND e.execution_token IS NULL AND e.execution_started_at IS NULL
       AND e.execution_lease_expires_at IS NULL
       AND e.scheduled_release_at <= clock_timestamp()
       AND b.status = 'confirmed'
       AND b.payment_flow_version = 'separate_charges_delayed_v1'
       AND hp.payout_account_status = 'active'
       AND hp.stripe_connect_account_id ~ '^acct_[A-Za-z0-9_]+$'
       AND p.status = 'succeeded'
       AND p.provider_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'
       AND p.amount_minor = pc.guest_total_minor AND pc.guest_total_minor > 0
       AND e.amount_minor = pc.host_payout_minor AND e.amount_minor > 0
       AND UPPER(TRIM(pc.currency)) ~ '^[A-Z]{3}$'
       AND UPPER(TRIM(p.currency)) = UPPER(TRIM(pc.currency))
       AND UPPER(TRIM(e.currency)) = UPPER(TRIM(pc.currency))
       AND (SELECT COUNT(*) FROM payment_attempts other WHERE other.booking_id = b.id) = 1
       AND NOT EXISTS (SELECT 1 FROM new_flow_refunds f WHERE f.booking_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM refunds f WHERE f.booking_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM payments lp WHERE lp.booking_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM payouts lp WHERE lp.booking_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM host_transfer_reversals r WHERE r.entitlement_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM cancellation_host_settlements s WHERE s.entitlement_id = e.id)
       ${queueDue}
     ORDER BY ${queueOrder} ASC, e.id ASC LIMIT $1`,
    values: useQueue ? [limit, "transfer_execute"] : [limit],
  };
}
