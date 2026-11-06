import crypto from "node:crypto";
import { withTransaction } from "../db";
import {
  isNewFlowRefundReconciliationEnabled,
  isNewFlowRefundExecutionEnabled,
} from "../config/featureFlags";
import {
  buildNewFlowRefundSelectionQuery,
  type RefundSelectionOperation,
} from "./selectNewFlowRefundJobs";
import type { FinancialBatchJob, FinancialBatchResult } from "./runNewFlowFinancialBatch";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lockNamespace = "host:new-flow-refund-queue-review";

function gate(operation: RefundSelectionOperation) {
  if (operation !== "refund_reconcile" && operation !== "refund_execute") {
    throw new Error("Invalid refund selection operation");
  }
  return operation === "refund_reconcile"
    ? isNewFlowRefundReconciliationEnabled
    : isNewFlowRefundExecutionEnabled;
}

export type RefundQueueSelection = {
  reviewToken: string;
  jobs: FinancialBatchJob[];
};

/**
 * Selects advisory jobs and persists a 30-second scheduling cooldown.
 * Per-operation serialization covers queue selection, not financial execution.
 * Never clears claims/leases, creates refunds or authorizes replay.
 * Output bounds do not cap all query work. Active SQL is not cancelled.
 * A competing selection pass returns an empty batch without waiting.
 */
export async function selectNewFlowRefundQueueJobs(
  operation: RefundSelectionOperation,
  limit = 25
): Promise<RefundQueueSelection> {
  const enabled = gate(operation);
  const query = buildNewFlowRefundSelectionQuery(operation, limit, true);
  const reviewToken = crypto.randomUUID();
  const empty: RefundQueueSelection = { reviewToken, jobs: [] };
  if (!enabled()) return empty;
  const disabled = new Error("Refund queue disabled");

  try {
    const jobs = await withTransaction(async client => {
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const lock = (await client.query(
        "SELECT pg_try_advisory_xact_lock(hashtext($1), hashtext($2)) AS acquired",
        [lockNamespace, operation]
      )).rows[0];
      if (!enabled()) throw disabled;
      if (lock.acquired !== true) return [];

      const candidates = await client.query(query.text, query.values);
      if (!enabled()) throw disabled;
      const selected: FinancialBatchJob[] = [];
      for (const row of candidates.rows) {
        if (!enabled()) throw disabled;
        const id = String(row.id);
        await client.query(
          `WITH checked AS (SELECT clock_timestamp() AS at)
           INSERT INTO new_flow_refund_queue_reviews
             (operation, refund_id, review_token,
              last_reviewed_at, next_review_at, review_failures, last_outcome)
           SELECT $1, $2, $3, checked.at, checked.at + INTERVAL '30 seconds',
                  0, 'selected' FROM checked WHERE true
           ON CONFLICT (operation, refund_id) DO UPDATE SET
             review_token = EXCLUDED.review_token,
             last_reviewed_at = EXCLUDED.last_reviewed_at,
             next_review_at = EXCLUDED.next_review_at,
             last_outcome = 'selected'`,
          [operation, id, reviewToken]
        );
        selected.push({ operation, id });
      }
      if (!enabled()) throw disabled;
      return selected;
    });
    return enabled() ? { reviewToken, jobs } : empty;
  } catch (error) {
    if (error === disabled) return empty;
    throw error;
  }
}

/**
 * Scheduling feedback only. True recorded outcomes reset backoff.
 * Errors or unresolved dispatched results back off 1, 2, 4... minutes to 1 hour.
 * Disabled/budget-exhausted jobs retain their selection cooldown.
 * Token plus selected-state checks reject stale and repeated feedback.
 * A feedback failure may occur after financial work committed; never retry
 * financial workers merely because scheduling feedback failed.
 */
export async function recordNewFlowRefundQueueResults(
  operation: RefundSelectionOperation,
  reviewToken: string,
  results: readonly FinancialBatchResult[]
): Promise<void> {
  const enabled = gate(operation);
  if (typeof reviewToken !== "string" || !uuid.test(reviewToken)) {
    throw new Error("Invalid refund queue review token");
  }
  if (!Array.isArray(results) || results.length > 25) {
    throw new Error("Invalid refund queue results");
  }
  const seen = new Set<string>();
  const validated = Array.from(results, result => {
    if (!result || result.operation !== operation ||
        typeof result.id !== "string" || !uuid.test(result.id) ||
        !["dispatched", "error", "disabled", "budget_exhausted"].includes(result.status)) {
      throw new Error("Invalid refund queue result");
    }
    const id = result.id.toLowerCase();
    if (seen.has(id)) throw new Error("Duplicate refund queue result");
    seen.add(id);
    return {
      id,
      update: result.status === "dispatched" || result.status === "error",
      resolved: result.status === "dispatched" && result.recorded === true,
    };
  });
  if (!enabled() || !validated.some(result => result.update)) return;
  const disabled = new Error("Refund queue disabled");

  try {
    await withTransaction(async client => {
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [lockNamespace, operation]
      );
      if (!enabled()) throw disabled;
      for (const result of validated) {
        if (!enabled()) throw disabled;
        if (!result.update) continue;
        await client.query(
          `WITH checked AS (SELECT clock_timestamp() AS at)
           UPDATE new_flow_refund_queue_reviews q SET
             last_reviewed_at = checked.at,
             next_review_at = checked.at + make_interval(secs =>
               CASE WHEN $4::boolean THEN 30::double precision
                    ELSE LEAST(3600::double precision,
                         60 * power(2::double precision, q.review_failures))
               END),
             review_failures = CASE WHEN $4::boolean THEN 0
                               ELSE LEAST(16, q.review_failures + 1) END,
             last_outcome = CASE WHEN $4::boolean THEN 'resolved' ELSE 'unresolved' END
           FROM checked
           WHERE q.operation = $1 AND q.refund_id = $2
             AND q.review_token = $3 AND q.last_outcome = 'selected'`,
          [operation, result.id, reviewToken.toLowerCase(), result.resolved]
        );
      }
      if (!enabled()) throw disabled;
    });
  } catch (error) {
    if (error === disabled) return;
    throw error;
  }
}
