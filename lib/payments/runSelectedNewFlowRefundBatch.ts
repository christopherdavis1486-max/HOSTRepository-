import {
  isNewFlowRefundExecutionEnabled,
  isNewFlowRefundReconciliationEnabled,
} from "../config/featureFlags";
import {
  selectNewFlowRefundJobs,
  type RefundSelectionOperation,
} from "./selectNewFlowRefundJobs";
import {
  runNewFlowFinancialBatch,
  type FinancialBatchResult,
} from "./runNewFlowFinancialBatch";

/**
 * Internal selection and dispatch for one refund operation.
 * Explicit queue opt-in persists cooldowns and records scheduling feedback.
 * Feedback can fail after financial work commits; never replay workers for it.
 * Committed cooldowns persist if later dispatch stops or fails.
 * No lease expiry, retries, API or cron wiring.
 * Selection is advisory; workers retain authorization and ownership checks.
 * The budget stops later dispatches and does not cancel an active read/worker.
 */
export async function runSelectedNewFlowRefundBatch(
  operation: RefundSelectionOperation,
  options: { limit?: number; budgetMs?: number; useRefundQueue?: boolean } = {}
): Promise<FinancialBatchResult[]> {
  const limit = options.limit ?? 25;
  const budgetMs = options.budgetMs ?? 30000;
  if (operation !== "refund_execute" && operation !== "refund_reconcile") {
    throw new Error("Invalid refund selection operation");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("Invalid refund selection limit");
  }
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 60000) {
    throw new Error("Invalid financial batch time budget");
  }

  if (options.useRefundQueue !== undefined && typeof options.useRefundQueue !== "boolean") {
    throw new Error("Invalid refund queue option");
  }
  const enabled = operation === "refund_execute"
    ? isNewFlowRefundExecutionEnabled : isNewFlowRefundReconciliationEnabled;
  if (options.useRefundQueue === true && !enabled()) return [];
  const started = performance.now();
  const queue = options.useRefundQueue === true ? await import("./newFlowRefundQueue") : null;
  const selection = queue ? await queue.selectNewFlowRefundQueueJobs(operation, limit) : null;
  const jobs = selection ? selection.jobs : await selectNewFlowRefundJobs(operation, limit);
  const remaining = Math.floor(budgetMs - (performance.now() - started));
  if (remaining < 1) {
    return jobs.map(job => ({ ...job, status: "budget_exhausted" as const }));
  }
  if (selection && !enabled()) {
    return jobs.map(job => ({ ...job, status: "disabled" as const }));
  }
  const results = await runNewFlowFinancialBatch(
    jobs, { budgetMs: Math.min(remaining, budgetMs) }
  );
  if (queue && selection) {
    await queue.recordNewFlowRefundQueueResults(operation, selection.reviewToken, results);
  }
  return results;
}
