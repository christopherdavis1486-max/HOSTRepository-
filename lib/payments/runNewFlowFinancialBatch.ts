import * as gates from "../config/featureFlags";

const operations = [
  "refund_execute", "refund_reconcile",
  "transfer_execute", "transfer_reconcile",
  "reversal_execute", "reversal_reconcile",
  "settlement_execute", "settlement_reconcile",
  "payment_reconcile", "missing_refund_recover"
] as const;

export type FinancialBatchOperation = typeof operations[number];
export type FinancialBatchJob = { operation: FinancialBatchOperation; id: string };
export type FinancialBatchResult = FinancialBatchJob & {
  status: "dispatched" | "disabled" | "error" | "budget_exhausted";
  recorded?: boolean;
  attempted?: boolean;
  reserved?: boolean;
};

const enabled: Record<FinancialBatchOperation, () => boolean> = {
  refund_execute: gates.isNewFlowRefundExecutionEnabled,
  refund_reconcile: gates.isNewFlowRefundReconciliationEnabled,
  transfer_execute: gates.isHostTransferExecutionEnabled,
  transfer_reconcile: gates.isHostTransferReconciliationEnabled,
  reversal_execute: gates.isTransferReversalExecutionEnabled,
  reversal_reconcile: gates.isTransferReversalReconciliationEnabled,
  settlement_execute: gates.isCancellationHostSettlementExecutionEnabled,
  settlement_reconcile: gates.isCancellationHostSettlementReconciliationEnabled,
  payment_reconcile: gates.isNewFlowPaymentReconciliationEnabled,
  missing_refund_recover: gates.isMissingLatePaymentRefundRecoveryEnabled,
};

async function dispatch(job: FinancialBatchJob) {
  switch (job.operation) {
    case "refund_execute":
      return (await import("./executeNewFlowRefund")).executeNewFlowRefund(job.id);
    case "refund_reconcile":
      return (await import("./reconcileNewFlowRefund")).reconcileNewFlowRefund(job.id);
    case "transfer_execute":
      return (await import("../payouts/hostTransfers")).attemptRelease(job.id);
    case "transfer_reconcile":
      return (await import("../payouts/reconcileHostTransfer")).reconcileHostTransfer(job.id);
    case "reversal_execute":
      return (await import("../payouts/transferReversal")).executeReversal(job.id);
    case "reversal_reconcile":
      return (await import("../payouts/reconcileTransferReversal")).reconcileTransferReversal(job.id);
    case "settlement_execute":
      return (await import("../payouts/executeCancellationHostSettlement")).executeCancellationHostSettlement(job.id);
    case "settlement_reconcile":
      return (await import("../payouts/reconcileCancellationHostSettlement")).reconcileCancellationHostSettlement(job.id);
    case "payment_reconcile":
      return (await import("./reconcileNewFlowPayment")).reconcileNewFlowPayment(job.id);
    case "missing_refund_recover":
      return (await import("./recoverMissingLatePaymentRefund")).recoverMissingLatePaymentRefund(job.id);
  }
}

/** Internal explicit-ID dispatcher; no API/cron wiring or automatic retries.
 * Workers retain authorization, ownership and provider verification duties.
 * Transfer execution requires an already-claimed entitlement.
 * The time budget stops later dispatches; it does not cancel an in-flight worker.
 * "dispatched" means the worker returned, not that money movement succeeded.
 */
export async function runNewFlowFinancialBatch(
  jobs: readonly FinancialBatchJob[],
  options: { budgetMs?: number } = {}
): Promise<FinancialBatchResult[]> {
  const budgetMs = options.budgetMs ?? 30000;
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 60000) {
    throw new Error("Invalid financial batch time budget");
  }
  if (!Array.isArray(jobs) || jobs.length > 25) {
    throw new Error("Financial batch must contain at most 25 explicit jobs");
  }
  const seen = new Set<string>();
  const validated: FinancialBatchJob[] = Array.from(jobs, job => {
    if (!job || !operations.includes(job.operation) ||
        typeof job.id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(job.id)) {
      throw new Error("Invalid financial batch job");
    }
    const id = job.id.toLowerCase();
    const resource = job.operation === "missing_refund_recover"
      ? "payment" : job.operation.split("_")[0];
    const key = resource + ":" + id;
    if (seen.has(key)) throw new Error("Duplicate or conflicting financial batch job");
    seen.add(key);
    return { operation: job.operation, id };
  });
  const deadline = performance.now() + budgetMs;
  const results: FinancialBatchResult[] = [];
  for (const job of validated) {
    if (performance.now() >= deadline) {
      results.push({ ...job, status: "budget_exhausted" });
      continue;
    }
    if (!enabled[job.operation]()) {
      results.push({ ...job, status: "disabled" });
      continue;
    }
    try {
      const outcome = await dispatch(job);
      const fields: { recorded?: unknown; attempted?: unknown; reserved?: unknown } = outcome;
      const result: FinancialBatchResult = { ...job, status: "dispatched" };
      for (const key of ["recorded", "attempted", "reserved"] as const) {
        const value = fields[key];
        if (typeof value === "boolean") result[key] = value;
      }
      results.push(result);
    } catch {
      // Do not retry or expose provider references, tokens or internal errors.
      results.push({ ...job, status: "error" });
    }
  }
  return results;
}
