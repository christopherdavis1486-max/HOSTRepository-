import {
  isNewFlowRefundReconciliationEnabled,
  isHostTransferReconciliationEnabled,
  isTransferReversalReconciliationEnabled,
  isCancellationHostSettlementReconciliationEnabled,
} from "../config/featureFlags";

export type FinancialExpiryOperation =
  | "refund_reconcile"
  | "transfer_reconcile"
  | "reversal_reconcile"
  | "settlement_reconcile";

const gates: Record<FinancialExpiryOperation, () => boolean> = {
  refund_reconcile: isNewFlowRefundReconciliationEnabled,
  transfer_reconcile: isHostTransferReconciliationEnabled,
  reversal_reconcile: isTransferReversalReconciliationEnabled,
  settlement_reconcile: isCancellationHostSettlementReconciliationEnabled,
};

/**
 * Internal bounded expiry pass for one independently enabled resource.
 * Flags uncertainty only; never dispatches workers or authorizes replay.
 * Pre-execution claims and historical rows without execution timestamps
 * remain outside this expiry path. No API/cron wiring.
 */
export async function flagExpiredNewFlowFinancialExecutions(
  operation: FinancialExpiryOperation,
  limit = 25
): Promise<string[]> {
  if (!Object.prototype.hasOwnProperty.call(gates, operation)) {
    throw new Error("Invalid financial expiry operation");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("Invalid financial expiry limit");
  }
  const enabled = gates[operation];
  if (!enabled()) return [];

  switch (operation) {
    case "refund_reconcile": {
      const worker = await import("./newFlowRefund");
      if (!enabled()) return [];
      return worker.flagExpiredNewFlowRefundsForReconciliation(limit);
    }
    case "transfer_reconcile": {
      const worker = await import("../payouts/flagExpiredTransferExecutions");
      if (!enabled()) return [];
      return worker.flagExpiredHostTransfers(limit);
    }
    case "reversal_reconcile": {
      const worker = await import("../payouts/flagExpiredTransferExecutions");
      if (!enabled()) return [];
      return worker.flagExpiredTransferReversals(limit);
    }
    case "settlement_reconcile": {
      const worker = await import("../payouts/reconcileCancellationHostSettlement");
      if (!enabled()) return [];
      return worker.flagExpiredCancellationHostSettlements(limit);
    }
  }
}
