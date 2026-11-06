import { db } from "../db";
import { isHostTransferReconciliationEnabled } from "../config/featureFlags";
import type { FinancialBatchJob } from "../payments/runNewFlowFinancialBatch";

/**
 * Read-only discovery of transfer reconciliation candidates.
 * Records already flagged for review may include historical executions.
 * Does not invent ownership, claim records, expire leases or call providers.
 * Cancellation does not erase a potentially existing transfer.
 * The worker must verify fresh provider evidence and transactional snapshots.
 */
export async function selectHostTransferReconciliationJobs(
  limit = 25
): Promise<FinancialBatchJob[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("Invalid transfer reconciliation selection limit");
  }
  if (!isHostTransferReconciliationEnabled()) return [];

  const query = buildHostTransferReconciliationSelectionQuery(limit);
  const result = await db.query(query.text, query.values);
  if (!isHostTransferReconciliationEnabled()) return [];
  return result.rows.map(row => ({
    operation: "transfer_reconcile", id: String(row.id),
  }));
}

/** Advisory discovery SQL; financial claims and workers recheck eligibility. */
export function buildHostTransferReconciliationSelectionQuery(
  limit = 25,
  useQueue = false
): { text: string; values: (string | number)[] } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("Invalid transfer reconciliation selection limit");
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
    ? "COALESCE(q.next_review_at, e.updated_at)" : "e.updated_at";
  return {
    text:
    `SELECT e.id
     FROM host_transfer_entitlements e
     JOIN bookings b ON b.id = e.booking_id AND b.host_id = e.host_id
     JOIN host_profiles hp ON hp.id = e.host_id
     JOIN booking_price_components pc ON pc.booking_id = b.id
     JOIN payment_attempts p ON p.booking_id = b.id
     ${queueJoin}
     WHERE e.status = 'transfer_reconciliation_required'
       AND e.provider_transfer_id IS NULL
       AND e.execution_lease_expires_at IS NULL
       AND b.payment_flow_version = 'separate_charges_delayed_v1'
       AND hp.stripe_connect_account_id ~ '^acct_[A-Za-z0-9_]+$'
       AND p.status = 'succeeded'
       AND p.provider_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'
       AND p.amount_minor = pc.guest_total_minor AND p.amount_minor > 0
       AND e.amount_minor = pc.host_payout_minor AND e.amount_minor > 0
       AND UPPER(TRIM(e.currency)) ~ '^[A-Z]{3}$'
       AND LOWER(TRIM(p.currency)) = LOWER(TRIM(pc.currency))
       AND LOWER(TRIM(e.currency)) = LOWER(TRIM(pc.currency))
       AND (SELECT COUNT(*) FROM payment_attempts other WHERE other.booking_id = b.id) = 1
       ${queueDue}
     ORDER BY ${queueOrder} ASC, e.id ASC
     LIMIT $1`,
    values: useQueue ? [limit, "transfer_reconcile"] : [limit],
  };
}
