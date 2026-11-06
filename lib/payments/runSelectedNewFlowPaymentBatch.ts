import {
  isNewFlowPaymentReconciliationEnabled,
  isMissingLatePaymentRefundRecoveryEnabled,
} from "../config/featureFlags";
import {
  selectNewFlowPaymentJobs,
  type PaymentSelectionOperation,
} from "./selectNewFlowPaymentJobs";
import {
  runNewFlowFinancialBatch,
  type FinancialBatchResult,
} from "./runNewFlowFinancialBatch";

/**
 * Internal selection and sequential dispatch for one independent operation.
 * Payment reconciliation may record verified success or terminal nonpayment.
 * Historical recovery may reserve a missing local refund; it never executes it.
 * No charge creation, automatic retries, claim resets or API/cron wiring.
 * Selection time reduces the dispatch budget. Active work is not cancelled.
 * Optional payment queue selection persists cooldowns before dispatch.
 * Outcome feedback is separate from financial commits and may fail afterward.
 * Feedback failure must never trigger automatic financial-worker replay.
 * Feedback SQL has its own timeouts and can extend the soft overall budget.
 */
export async function runSelectedNewFlowPaymentBatch(
  operation: PaymentSelectionOperation,
  options: { limit?: number; budgetMs?: number; usePaymentQueue?: boolean } = {}
): Promise<FinancialBatchResult[]> {
  if (operation !== "payment_reconcile" && operation !== "missing_refund_recover") {
    throw new Error("Invalid payment selection operation");
  }
  const limit = options.limit ?? 25;
  const budgetMs = options.budgetMs ?? 30000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("Invalid payment selection limit");
  }
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 60000) {
    throw new Error("Invalid financial batch time budget");
  }

  if (options.usePaymentQueue !== undefined &&
      typeof options.usePaymentQueue !== "boolean") {
    throw new Error("Invalid payment queue option");
  }

  const enabled = operation === "payment_reconcile"
    ? isNewFlowPaymentReconciliationEnabled
    : isMissingLatePaymentRefundRecoveryEnabled;
  if (!enabled()) return [];

  const started = performance.now();
  const queue = options.usePaymentQueue === true
    ? await import("./newFlowPaymentQueue") : null;
  const batch = queue ? await queue.selectNewFlowPaymentQueueJobs(operation, limit) : null;
  const jobs = batch ? batch.jobs : await selectNewFlowPaymentJobs(operation, limit);
  const remaining = Math.floor(budgetMs - (performance.now() - started));
  if (remaining < 1) {
    return jobs.map(job => ({ ...job, status: "budget_exhausted" as const }));
  }
  if (!enabled()) {
    return jobs.map(job => ({ ...job, status: "disabled" as const }));
  }

  const results = await runNewFlowFinancialBatch(
    jobs, { budgetMs: Math.min(remaining, budgetMs) }
  );
  if (queue && batch) {
    await queue.recordNewFlowPaymentQueueResults(operation, batch.reviewToken, results);
  }
  return results;
}
