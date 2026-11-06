import { db } from "../db";
import {
  isTransferReversalExecutionEnabled,
  isTransferReversalReconciliationEnabled,
} from "../config/featureFlags";
import { reversalFinancialEligibility } from "./withTransferReversalProviderLock";
import type { FinancialBatchJob } from "../payments/runNewFlowFinancialBatch";

export type ReversalSelectionOperation =
  | "reversal_execute"
  | "reversal_reconcile";

/**
 * Read-only, bounded discovery. Selection is not authorization.
 * Workers independently claim or verify fresh evidence.
 * No execution reset, automatic reclaim or provider operations.
 */
export function buildTransferReversalSelectionQuery(
  operation: ReversalSelectionOperation,
  limit = 25,
  useQueue = false
): { text: string; values: (number | string)[] } {
  if (operation !== "reversal_execute" && operation !== "reversal_reconcile") {
    throw new Error("Invalid reversal selection operation");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("Invalid reversal selection limit");
  }
  if (typeof useQueue !== "boolean") throw new Error("Invalid reversal queue option");
  // Substitute only fixed SQL column expressions into the existing predicate.
  // No caller input is interpolated. The limit remains a bound parameter.
  const expressions = [
    "r.amount_minor",
    "r.idempotency_key",
    "e.provider_transfer_id",
    "e.currency",
    "hp.stripe_connect_account_id",
  ];
  const eligibility = reversalFinancialEligibility(1, 2, 3, 4, 5)
    .replace(/\$([1-5])\b/g, (_match, index: string) =>
      expressions[Number(index) - 1]
    );

  const state = operation === "reversal_execute"
    ? `r.status = 'reversal_requested'
       AND r.execution_token IS NULL
       AND r.execution_started_at IS NULL
       AND r.execution_lease_expires_at IS NULL`
    : `r.status = 'reversal_reconciliation_required'
       AND r.execution_lease_expires_at IS NULL`;
  let text = `WITH candidates AS MATERIALIZED (
       SELECT r.*
       FROM host_transfer_reversals r
       WHERE ${state}
         AND r.provider_reversal_id IS NULL
         AND r.confirmed_at IS NULL
     )
     SELECT r.id
     FROM candidates r
     JOIN host_transfer_entitlements e ON e.id = r.entitlement_id
     JOIN host_profiles hp ON hp.id = e.host_id
     WHERE EXISTS (
       SELECT 1
       FROM host_transfer_reversals
       WHERE id = r.id
       ${eligibility}
       OFFSET 0
     )
     ORDER BY r.requested_at ASC, r.id ASC
     LIMIT $1`;
  if (useQueue) {
    text = text.replace("FROM candidates r", () =>
      "FROM candidates r LEFT JOIN transfer_reversal_queue_reviews q" +
      " ON q.reversal_id = r.id AND q.operation = $2");
    text = text.replace("WHERE EXISTS (", () =>
      "WHERE (q.reversal_id IS NULL OR q.next_review_at <= clock_timestamp()) AND EXISTS (");
    text = text.replace("ORDER BY r.requested_at ASC, r.id ASC", () =>
      "ORDER BY q.last_reviewed_at ASC NULLS FIRST, r.requested_at ASC, r.id ASC");
  }
  return { text, values: useQueue ? [limit, operation] : [limit] };
}

export async function selectTransferReversalJobs(
  operation: ReversalSelectionOperation,
  limit = 25
): Promise<FinancialBatchJob[]> {
  if (operation !== "reversal_execute" && operation !== "reversal_reconcile") {
    throw new Error("Invalid reversal selection operation");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("Invalid reversal selection limit");
  }

  const enabled = operation === "reversal_execute"
    ? isTransferReversalExecutionEnabled
    : isTransferReversalReconciliationEnabled;
  if (!enabled()) return [];

  const query = buildTransferReversalSelectionQuery(operation, limit);
  const result = await db.query(query.text, query.values);

  if (!enabled()) return [];
  return result.rows.map(row => ({
    operation,
    id: String(row.id),
  }));
}
