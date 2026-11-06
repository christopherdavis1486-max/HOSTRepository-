import { db } from "../db";
import {
  isNewFlowRefundExecutionEnabled,
  isNewFlowRefundReconciliationEnabled,
} from "../config/featureFlags";
import type { FinancialBatchJob } from "./runNewFlowFinancialBatch";

export type RefundSelectionOperation = "refund_execute" | "refund_reconcile";

/**
 * Read-only candidate discovery, not financial authorization.
 * Returns at most one coordinator-sized batch for one operation.
 * Does not claim records, expire leases, call providers or dispatch workers.
 * Workers must recheck current authorization and ownership.
 * Repeated selection can return the same unresolved candidates.
 */
export async function selectNewFlowRefundJobs(
  operation: RefundSelectionOperation,
  limit = 25
): Promise<FinancialBatchJob[]> {
  if (operation !== "refund_execute" && operation !== "refund_reconcile") {
    throw new Error("Invalid refund selection operation");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("Invalid refund selection limit");
  }
  const enabled = operation === "refund_execute"
    ? isNewFlowRefundExecutionEnabled
    : isNewFlowRefundReconciliationEnabled;
  if (!enabled()) return [];

  const query = buildNewFlowRefundSelectionQuery(operation, limit);
  const result = await db.query(query.text, query.values);
  // A gate may have changed while the database read was in flight.
  if (!enabled()) return [];
  return result.rows.map(row => ({ operation, id: String(row.id) }));
}

/** Builds advisory discovery SQL; workers retain financial authorization. */
export function buildNewFlowRefundSelectionQuery(
  operation: RefundSelectionOperation,
  limit = 25,
  useQueue = false
): { text: string; values: (string | number)[] } {
  if (operation !== "refund_execute" && operation !== "refund_reconcile") {
    throw new Error("Invalid refund selection operation");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("Invalid refund selection limit");
  }
  if (typeof useQueue !== "boolean") {
    throw new Error("Invalid refund queue selection option");
  }
  const state = operation === "refund_execute"
    ? `r.status = 'pending'
       AND r.reconciliation_required = FALSE
       AND r.claim_token IS NULL
       AND r.execution_started_at IS NULL
       AND r.lease_expires_at IS NULL`
    : `r.status = 'processing'
       AND r.reconciliation_required = TRUE
       AND r.claim_token IS NOT NULL
       AND r.execution_started_at IS NOT NULL
       AND r.lease_expires_at IS NULL`;
  const order = operation === "refund_execute" ? "r.created_at" : "r.updated_at";
  const queueJoin = useQueue
    ? "LEFT JOIN new_flow_refund_queue_reviews q ON q.refund_id = r.id AND q.operation = $2"
    : "";
  const queueDue = useQueue
    ? "AND (q.next_review_at IS NULL OR q.next_review_at <= clock_timestamp())"
    : "";
  const queueOrder = useQueue ? "COALESCE(q.next_review_at, " + order + ")" : order;

  return {
    text:
    `SELECT r.id
     FROM new_flow_refunds r
     JOIN bookings b ON b.id = r.booking_id
     ${queueJoin}
     JOIN payment_attempts p
       ON p.id = r.payment_attempt_id AND p.booking_id = r.booking_id
     WHERE ${state}
       AND r.provider_refund_id IS NULL
       AND b.payment_flow_version = 'separate_charges_delayed_v1'
       AND b.status = 'cancelled'
       AND p.status = 'succeeded'
       AND p.provider_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'
       AND r.amount_minor > 0 AND r.amount_minor <= p.amount_minor
       AND r.currency ~ '^[A-Za-z]{3}$'
       AND LOWER(r.currency) = LOWER(p.currency)
       AND (SELECT COUNT(*) FROM payment_attempts other
            WHERE other.booking_id = b.id) = 1
       ${queueDue}
     ORDER BY ${queueOrder} ASC, r.id ASC
     LIMIT $1`,
    values: useQueue ? [limit, operation] : [limit],
  };
}
