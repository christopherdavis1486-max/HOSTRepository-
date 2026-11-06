import {
  isNewFlowRefundReconciliationEnabled,
  isHostTransferReconciliationEnabled,
} from "../config/featureFlags";
import { flagExpiredNewFlowFinancialExecutions } from "./flagExpiredNewFlowFinancialExecutions";
import { selectNewFlowRefundJobs } from "./selectNewFlowRefundJobs";
import { selectHostTransferReconciliationJobs } from "../payouts/selectHostTransferReconciliationJobs";
import { runNewFlowFinancialBatch, type FinancialBatchResult } from "./runNewFlowFinancialBatch";

export type ReconciliationPassOperation = "refund_reconcile" | "transfer_reconcile";
export type ReconciliationPassResult = {
  status: "completed" | "disabled" | "budget_exhausted";
  expiredIds: string[];
  results: FinancialBatchResult[];
};

/**
 * Internal expiry -> selection -> reconciliation for one resource.
 * "completed" means the pass returned, not that money movement was verified.
 * Refund/transfer queue opt-ins preserve expiry-before-selection ordering.
 * Queue cooldowns persist after later failure; feedback never authorizes replay.
 * Feedback may fail after financial completion and has separate SQL timeouts.
 * No provider creation, execution replay, claim reset or API/cron wiring.
 * Expiry changes persist if a later phase fails or exhausts its budget.
 * Active queries and workers are not cancelled by this soft time budget.
 */
export async function runNewFlowReconciliationPass(
  operation: ReconciliationPassOperation,
  options: { limit?: number; budgetMs?: number; useRefundQueue?: boolean; useTransferQueue?: boolean } = {}
): Promise<ReconciliationPassResult> {
  if (operation !== "refund_reconcile" && operation !== "transfer_reconcile") {
    throw new Error("Invalid reconciliation pass operation");
  }
  const limit = options.limit ?? 25;
  const budgetMs = options.budgetMs ?? 30000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("Invalid reconciliation pass limit");
  }
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 60000) {
    throw new Error("Invalid financial batch time budget");
  }
  if (options.useRefundQueue !== undefined && typeof options.useRefundQueue !== "boolean") {
    throw new Error("Invalid refund queue option");
  }
  if (options.useRefundQueue === true && operation !== "refund_reconcile") {
    throw new Error("Refund queue requires refund reconciliation");
  }
  if (options.useTransferQueue !== undefined && typeof options.useTransferQueue !== "boolean") {
    throw new Error("Invalid host transfer queue option");
  }
  if (options.useTransferQueue === true && operation !== "transfer_reconcile") {
    throw new Error("Transfer queue requires transfer reconciliation");
  }
  const enabled = operation === "refund_reconcile"
    ? isNewFlowRefundReconciliationEnabled : isHostTransferReconciliationEnabled;
  if (!enabled()) return { status: "disabled", expiredIds: [], results: [] };

  const started = performance.now();
  const remaining = () => Math.floor(budgetMs - (performance.now() - started));
  const expiredIds = await flagExpiredNewFlowFinancialExecutions(operation, limit);
  if (remaining() < 1) return { status: "budget_exhausted", expiredIds, results: [] };
  if (!enabled()) return { status: "disabled", expiredIds, results: [] };

  const queue = options.useRefundQueue === true ? await import("./newFlowRefundQueue") : null;
  const transferQueue = options.useTransferQueue === true
    ? await import("../payouts/hostTransferQueue") : null;
  const selection = queue
    ? await queue.selectNewFlowRefundQueueJobs("refund_reconcile", limit)
    : transferQueue
      ? await transferQueue.selectHostTransferQueueJobs("transfer_reconcile", limit) : null;
  const jobs = selection ? selection.jobs : operation === "refund_reconcile"
    ? await selectNewFlowRefundJobs(operation, limit)
    : await selectHostTransferReconciliationJobs(limit);
  const left = remaining();
  if (left < 1) {
    return {
      status: "budget_exhausted", expiredIds,
      results: jobs.map(job => ({ ...job, status: "budget_exhausted" as const })),
    };
  }
  if (selection && !enabled()) {
    return {
      status: "disabled", expiredIds,
      results: jobs.map(job => ({ ...job, status: "disabled" as const })),
    };
  }
  const results = await runNewFlowFinancialBatch(
    jobs, { budgetMs: Math.min(left, budgetMs) }
  );
  if (queue && selection) {
    await queue.recordNewFlowRefundQueueResults(
      "refund_reconcile", selection.reviewToken, results
    );
  } else if (transferQueue && selection) {
    await transferQueue.recordHostTransferQueueResults(
      "transfer_reconcile", selection.reviewToken, results
    );
  }
  return { status: "completed", expiredIds, results };
}
