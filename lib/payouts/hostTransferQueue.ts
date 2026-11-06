import crypto from "node:crypto";
import { withTransaction } from "../db";
import {
  isHostTransferReconciliationEnabled,
  isHostTransferExecutionEnabled,
} from "../config/featureFlags";
import { buildClaimableHostTransferSelectionQuery } from "./selectAndClaimHostTransfers";
import { buildHostTransferReconciliationSelectionQuery } from "./selectHostTransferReconciliationJobs";
import type { FinancialBatchJob, FinancialBatchResult } from "../payments/runNewFlowFinancialBatch";

export type HostTransferQueueOperation = "transfer_execute" | "transfer_reconcile";
export type HostTransferQueueResult = FinancialBatchResult | {
  operation: "transfer_execute";
  id: string;
  status: "not_claimed" | "claim_error";
};

function buildHostTransferQueueSelectionQuery(
  operation: HostTransferQueueOperation, limit: number, useQueue: boolean
) {
  return operation === "transfer_execute"
    ? buildClaimableHostTransferSelectionQuery(limit, useQueue)
    : buildHostTransferReconciliationSelectionQuery(limit, useQueue);
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lockNamespace = "host:host-transfer-queue-review";

function gate(operation: HostTransferQueueOperation) {
  if (operation !== "transfer_reconcile" && operation !== "transfer_execute") {
    throw new Error("Invalid host transfer selection operation");
  }
  return operation === "transfer_reconcile"
    ? isHostTransferReconciliationEnabled
    : isHostTransferExecutionEnabled;
}

export type HostTransferQueueSelection = {
  reviewToken: string;
  jobs: FinancialBatchJob[];
};

/**
 * Selects advisory jobs and persists a 30-second scheduling cooldown.
 * Per-operation serialization covers queue selection, not financial execution.
 * Never clears claims/leases, creates transfers or authorizes replay.
 * Output bounds do not cap all query work. Active SQL is not cancelled.
 * A competing selection pass returns an empty batch without waiting.
 */
export async function selectHostTransferQueueJobs(
  operation: HostTransferQueueOperation,
  limit = 25
): Promise<HostTransferQueueSelection> {
  const enabled = gate(operation);
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("Invalid host transfer selection limit");
  }
  const query = buildHostTransferQueueSelectionQuery(operation, limit, true);
  const reviewToken = crypto.randomUUID();
  const empty: HostTransferQueueSelection = { reviewToken, jobs: [] };
  if (!enabled()) return empty;
  const disabled = new Error("Host transfer queue disabled");

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
           INSERT INTO host_transfer_queue_reviews
             (operation, entitlement_id, review_token,
              last_reviewed_at, next_review_at, review_failures, last_outcome)
           SELECT $1, $2, $3, checked.at, checked.at + INTERVAL '30 seconds',
                  0, 'selected' FROM checked WHERE true
           ON CONFLICT (operation, entitlement_id) DO UPDATE SET
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
 * Scheduling feedback only; never financial authorization.
 * Reconciliation uses recorded === true. Execution additionally requires
 * an advisory stored transfer_created state, valid provider ID and cleared lease.
 * Attempted alone never resolves feedback. No provider references are returned.
 * Lost or uncertain first claims back off without resetting financial ownership.
 * Errors or unresolved dispatched results back off 1, 2, 4... minutes to 1 hour.
 * Disabled/budget-exhausted jobs retain their selection cooldown.
 * Token plus selected-state checks reject stale and repeated feedback.
 * A feedback failure may occur after financial work committed; never retry
 * financial workers merely because scheduling feedback failed.
 */
export async function recordHostTransferQueueResults(
  operation: HostTransferQueueOperation,
  reviewToken: string,
  results: readonly HostTransferQueueResult[]
): Promise<void> {
  const enabled = gate(operation);
  if (typeof reviewToken !== "string" || !uuid.test(reviewToken)) {
    throw new Error("Invalid host transfer queue review token");
  }
  if (!Array.isArray(results) || results.length > 25) {
    throw new Error("Invalid host transfer queue results");
  }
  const seen = new Set<string>();
  const validated = Array.from(results, result => {
    if (!result || result.operation !== operation ||
        typeof result.id !== "string" || !uuid.test(result.id) ||
        !["dispatched", "error", "disabled", "budget_exhausted", "not_claimed", "claim_error"].includes(result.status) ||
        (operation === "transfer_reconcile" &&
          (result.status === "not_claimed" || result.status === "claim_error"))) {
      throw new Error("Invalid host transfer queue result");
    }
    const id = result.id.toLowerCase();
    if (seen.has(id)) throw new Error("Duplicate host transfer queue result");
    seen.add(id);
    return {
      id,
      update: ["dispatched", "error", "not_claimed", "claim_error"].includes(result.status),
      inspectExecution: operation === "transfer_execute" && result.status === "dispatched" &&
        "attempted" in result && result.attempted === true,
      resolved: operation === "transfer_reconcile" && result.status === "dispatched" &&
        "recorded" in result && result.recorded === true,
    };
  });
  if (!enabled() || !validated.some(result => result.update)) return;
  const disabled = new Error("Host transfer queue disabled");

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
        let resolved = result.resolved;
        if (result.inspectExecution) {
          // Advisory scheduling read only: no financial row locks or writes.
          const state = (await client.query(
            "SELECT status = 'transfer_created' AND provider_transfer_id ~ '^tr_[A-Za-z0-9_]+$' AND execution_lease_expires_at IS NULL AS complete FROM host_transfer_entitlements WHERE id = $1",
            [result.id]
          )).rows[0];
          resolved = state?.complete === true;
        }
        await client.query(
          `WITH checked AS (SELECT clock_timestamp() AS at)
           UPDATE host_transfer_queue_reviews q SET
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
           WHERE q.operation = $1 AND q.entitlement_id = $2
             AND q.review_token = $3 AND q.last_outcome = 'selected'`,
          [operation, result.id, reviewToken.toLowerCase(), resolved]
        );
      }
      if (!enabled()) throw disabled;
    });
  } catch (error) {
    if (error === disabled) return;
    throw error;
  }
}
