import {
  isTransferReversalExecutionEnabled,
  isTransferReversalReconciliationEnabled,
  isCancellationHostSettlementExecutionEnabled,
  isCancellationHostSettlementReconciliationEnabled,
} from "../config/featureFlags";
import {
  selectTransferReversalJobs,
  type ReversalSelectionOperation,
} from "../payouts/selectTransferReversalJobs";
import {
  selectCancellationSettlementJobs,
  type SettlementSelectionOperation,
} from "../payouts/selectCancellationSettlementJobs";
import { flagExpiredNewFlowFinancialExecutions } from "./flagExpiredNewFlowFinancialExecutions";
import {
  runNewFlowFinancialBatch,
  type FinancialBatchResult,
} from "./runNewFlowFinancialBatch";

export type CancellationFinancialOperation =
  | ReversalSelectionOperation
  | SettlementSelectionOperation;

export type CancellationFinancialBatchResult = {
  status: "completed" | "disabled" | "budget_exhausted";
  expiredIds: string[];
  results: FinancialBatchResult[];
};

const gates: Record<CancellationFinancialOperation, () => boolean> = {
  reversal_execute: isTransferReversalExecutionEnabled,
  reversal_reconcile: isTransferReversalReconciliationEnabled,
  settlement_execute: isCancellationHostSettlementExecutionEnabled,
  settlement_reconcile: isCancellationHostSettlementReconciliationEnabled,
};

/**
 * Internal bounded selection and dispatch for one independent operation.
 * Reconciliation first flags expired executions; execution never runs expiry.
 * No automatic retries, execution resets, reclaim or API/cron wiring.
 * Expiry changes persist if a later phase fails or stops.
 * The soft budget cannot cancel an active query or worker.
 * "completed" describes the pass, not verified financial completion.
 * Optional settlement/reversal queue review persists cooldowns before dispatch.
 * Reversal feedback can fail after financial completion; never redispatch for that failure.
 * Those hints persist if dispatch later fails, is disabled or exceeds budget.
 */
export async function runSelectedCancellationFinancialBatch(
  operation: CancellationFinancialOperation,
  options: { limit?: number; budgetMs?: number; useSettlementQueue?: boolean; useReversalQueue?: boolean } = {}
): Promise<CancellationFinancialBatchResult> {
  if (!Object.prototype.hasOwnProperty.call(gates, operation)) {
    throw new Error("Invalid cancellation financial operation");
  }
  const limit = options.limit ?? 25;
  const budgetMs = options.budgetMs ?? 30000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("Invalid cancellation financial selection limit");
  }
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 60000) {
    throw new Error("Invalid financial batch time budget");
  }

  if (options.useSettlementQueue !== undefined &&
      typeof options.useSettlementQueue !== "boolean") {
    throw new Error("Invalid settlement queue option");
  }
  if (options.useSettlementQueue === true &&
      operation !== "settlement_execute" && operation !== "settlement_reconcile") {
    throw new Error("Settlement queue option requires a settlement operation");
  }

  if (options.useReversalQueue !== undefined &&
      typeof options.useReversalQueue !== "boolean") {
    throw new Error("Invalid reversal queue option");
  }
  if (options.useReversalQueue === true &&
      operation !== "reversal_execute" && operation !== "reversal_reconcile") {
    throw new Error("Reversal queue option requires a reversal operation");
  }

  const enabled = gates[operation];
  const expiredIds: string[] = [];
  if (!enabled()) return { status: "disabled", expiredIds, results: [] };
  const started = performance.now();
  const remaining = () => Math.floor(budgetMs - (performance.now() - started));

  if (operation === "reversal_reconcile" || operation === "settlement_reconcile") {
    expiredIds.push(...await flagExpiredNewFlowFinancialExecutions(operation, limit));
  }
  if (remaining() < 1) return { status: "budget_exhausted", expiredIds, results: [] };
  if (!enabled()) return { status: "disabled", expiredIds, results: [] };

  const reversalQueue = options.useReversalQueue === true
    ? await import("../payouts/transferReversalQueue") : null;
  const reversalSelection = reversalQueue &&
      (operation === "reversal_execute" || operation === "reversal_reconcile")
    ? await reversalQueue.selectTransferReversalQueueJobs(operation, limit) : null;
  const jobs = reversalSelection ? reversalSelection.jobs
    : operation === "reversal_execute" || operation === "reversal_reconcile"
    ? await selectTransferReversalJobs(operation, limit)
    : options.useSettlementQueue === true
      ? await (await import("../payouts/reviewCancellationSettlementQueue"))
          .reviewCancellationSettlementQueue(operation, limit)
      : await selectCancellationSettlementJobs(operation, limit);
  const left = remaining();
  if (left < 1) {
    return {
      status: "budget_exhausted", expiredIds,
      results: jobs.map(job => ({ ...job, status: "budget_exhausted" as const })),
    };
  }
  if (!enabled()) {
    return {
      status: "disabled", expiredIds,
      results: jobs.map(job => ({ ...job, status: "disabled" as const })),
    };
  }

  const results = await runNewFlowFinancialBatch(
    jobs, { budgetMs: Math.min(left, budgetMs) }
  );
  if (reversalQueue && reversalSelection &&
      (operation === "reversal_execute" || operation === "reversal_reconcile")) {
    await reversalQueue.recordTransferReversalQueueResults(
      operation, reversalSelection.reviewToken, results
    );
  }
  return { status: "completed", expiredIds, results };
}
