import { db } from "../db";
import {
  isCancellationHostSettlementExecutionEnabled,
  isCancellationHostSettlementReconciliationEnabled,
} from "../config/featureFlags";
import { cancellationSettlementEligibility } from "./cancellationSettlementEligibility";
import type { FinancialBatchJob } from "../payments/runNewFlowFinancialBatch";

export type SettlementSelectionOperation =
  | "settlement_execute"
  | "settlement_reconcile";

const evidenceReviewErrors = new Set([
  "Settlement record or linked evidence is missing",
  "Settlement evidence, account or release eligibility requires review",
  "Additional financial records require settlement review",
  "Unexpected refund blocks retained payout",
  "Guest refund must be verified complete before retained payout",
]);

function eligibleState(row: any, execution: boolean) {
  if (row.provider_transfer_id !== null ||
      row.execution_lease_expires_at !== null) return false;
  return execution
    ? row.status === "pending" &&
      row.execution_token === null && row.execution_started_at === null
    : row.status === "reconciliation_required" &&
      row.execution_token !== null && row.execution_started_at !== null;
}

/**
 * Read-only discovery within a bounded candidate window.
 * Inspects at most `limit` candidates and may return fewer jobs.
 * Invalid older candidates can occupy the window; fairness/backoff is separate.
 * Eligibility reads are advisory and may observe concurrent changes.
 * Workers independently lock, recheck and verify evidence.
 * No claims, lease expiry, execution resets or provider operations.
 */
export async function selectCancellationSettlementJobs(
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

  const state = execution
    ? `s.status = 'pending'
       AND s.execution_token IS NULL
       AND s.execution_started_at IS NULL
       AND s.scheduled_release_at <= clock_timestamp()`
    : `s.status = 'reconciliation_required'
       AND s.execution_token IS NOT NULL
       AND s.execution_started_at IS NOT NULL`;
  const order = execution ? "s.scheduled_release_at" : "s.updated_at";
  const candidates = await db.query(
    `SELECT s.id
     FROM cancellation_host_settlements s
     JOIN bookings b ON b.id = s.booking_id AND b.host_id = s.host_id
     WHERE ${state}
       AND s.provider_transfer_id IS NULL
       AND s.execution_lease_expires_at IS NULL
       AND b.payment_flow_version = 'separate_charges_delayed_v1'
     ORDER BY ${order} ASC, s.id ASC
     LIMIT $1`,
    [limit]
  );
  if (!enabled()) return [];

  const jobs: FinancialBatchJob[] = [];
  for (const candidate of candidates.rows) {
    if (!enabled()) return [];
    const eligible = await isCancellationSettlementCandidateEligible(
      db, String(candidate.id), execution
    );
    if (!enabled()) return [];
    if (eligible) {
      jobs.push({ operation, id: String(candidate.id) });
    }
  }
  return enabled() ? jobs : [];
}


/** Shared advisory check; execution workers still independently authorize. */
export async function isCancellationSettlementCandidateEligible(
  client: Parameters<typeof cancellationSettlementEligibility>[0],
  id: string,
  execution: boolean
): Promise<boolean> {
  try {
    const row = await cancellationSettlementEligibility(client, id, false, execution);
    return eligibleState(row, execution);
  } catch (error) {
    if (error instanceof Error && evidenceReviewErrors.has(error.message)) {
      return false;
    }
    throw error;
  }
}
