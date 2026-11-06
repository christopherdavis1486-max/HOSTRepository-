import { withTransaction } from "../db";
import {
  isCancellationHostSettlementExecutionEnabled,
  isCancellationHostSettlementReconciliationEnabled,
} from "../config/featureFlags";
import {
  isCancellationSettlementCandidateEligible,
  type SettlementSelectionOperation,
} from "./selectCancellationSettlementJobs";
import type { FinancialBatchJob } from "../payments/runNewFlowFinancialBatch";

/**
 * Reviews at most limit candidates and writes scheduling hints only.
 * Known evidence problems back off 1, 2, 4... minutes, capped at one hour.
 * Eligible candidates receive a 30-second cooldown even if dispatch never runs.
 * Repeated review does not authorize replay or establish financial completion.
 * The per-operation advisory lock serializes these review passes only.
 * Financial workers keep their own locks and evidence checks.
 * Errors roll back this pass's queue writes; no automatic retries.
 * A finite backlog rotates as reviewed records enter cooldown.
 * Sustained overload, queue housekeeping and worker-outcome backoff are separate.
 */
export async function reviewCancellationSettlementQueue(
  operation: SettlementSelectionOperation,
  limit = 25
): Promise<FinancialBatchJob[]> {
  if (operation !== "settlement_execute" && operation !== "settlement_reconcile") {
    throw new Error("Invalid settlement selection operation");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("Invalid settlement selection limit");
  }

  const execution = operation === "settlement_execute";
  const enabled = execution
    ? isCancellationHostSettlementExecutionEnabled
    : isCancellationHostSettlementReconciliationEnabled;
  if (!enabled()) return [];

  const disabled = new Error("Settlement queue review disabled");
  try {
    const jobs = await withTransaction(async client => {
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const lock = (await client.query(
        `SELECT pg_try_advisory_xact_lock(
           hashtext('host:cancellation-settlement-queue-review'),
           hashtext($1)
         ) AS acquired`,
        [operation]
      )).rows[0];
      if (!enabled()) throw disabled;
      if (lock.acquired !== true) return [];

      const state = execution
        ? `s.status = 'pending'
           AND s.execution_token IS NULL
           AND s.execution_started_at IS NULL
           AND s.scheduled_release_at <= clock_timestamp()`
        : `s.status = 'reconciliation_required'
           AND s.execution_token IS NOT NULL
           AND s.execution_started_at IS NOT NULL`;
      const order = execution ? "s.scheduled_release_at" : "s.updated_at";
      const candidates = await client.query(
        `SELECT s.id, COALESCE(q.review_failures, 0) AS review_failures
         FROM cancellation_host_settlements s
         JOIN bookings b ON b.id = s.booking_id AND b.host_id = s.host_id
         LEFT JOIN cancellation_settlement_queue_reviews q
           ON q.settlement_id = s.id AND q.operation = $2
         WHERE ${state}
           AND s.provider_transfer_id IS NULL
           AND s.execution_lease_expires_at IS NULL
           AND b.payment_flow_version = 'separate_charges_delayed_v1'
           AND (q.next_review_at IS NULL OR q.next_review_at <= clock_timestamp())
         ORDER BY COALESCE(q.next_review_at, ${order}) ASC, s.id ASC
         LIMIT $1`,
        [limit, operation]
      );
      if (!enabled()) throw disabled;

      const selected: FinancialBatchJob[] = [];
      for (const candidate of candidates.rows) {
        if (!enabled()) throw disabled;
        const id = String(candidate.id);
        const eligible = await isCancellationSettlementCandidateEligible(
          client, id, execution
        );
        if (!enabled()) throw disabled;

        const failures = eligible ? 0
          : Math.min(16, Number(candidate.review_failures) + 1);
        const seconds = eligible ? 30
          : Math.min(3600, 60 * 2 ** (failures - 1));

        await client.query(
          `WITH checked AS (SELECT clock_timestamp() AS at)
           INSERT INTO cancellation_settlement_queue_reviews
             (operation, settlement_id, last_reviewed_at, next_review_at,
              review_failures, last_outcome)
           SELECT $1, $2, checked.at,
                  checked.at + make_interval(secs => $3::double precision),
                  $4, $5
           FROM checked
           WHERE true
           ON CONFLICT (operation, settlement_id) DO UPDATE SET
             last_reviewed_at = EXCLUDED.last_reviewed_at,
             next_review_at = EXCLUDED.next_review_at,
             review_failures = EXCLUDED.review_failures,
             last_outcome = EXCLUDED.last_outcome`,
          [operation, id, seconds, failures,
           eligible ? "eligible" : "review_required"]
        );
        if (eligible) selected.push({ operation, id });
      }
      if (!enabled()) throw disabled;
      return selected;
    });
    return enabled() ? jobs : [];
  } catch (error) {
    if (error === disabled) return [];
    throw error;
  }
}
