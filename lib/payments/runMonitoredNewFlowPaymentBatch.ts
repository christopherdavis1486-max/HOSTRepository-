import type { Pool } from "pg";
import type { runSelectedNewFlowPaymentBatch } from "./runSelectedNewFlowPaymentBatch";
import { runWithFinancialRunnerHeartbeat } from "./runWithFinancialRunnerHeartbeat";

type Runner = typeof runSelectedNewFlowPaymentBatch;
type Operation = Parameters<Runner>[0];
type Options = NonNullable<Parameters<Runner>[1]>;

/**
 * Explicit monitored entry point for payment selection.
 * Existing direct callers remain unchanged. No scheduler or retry.
 * Callers must inspect both execution and heartbeat outcomes.
 * Financial gates and authorization remain inside the existing runner.
 */
export async function runMonitoredNewFlowPaymentBatch(
  database: Pick<Pool, "query">,
  operation: Operation,
  options: Options = {}
) {
  if (operation !== "payment_reconcile" && operation !== "missing_refund_recover") {
    throw new Error("Invalid monitored payment operation");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Invalid monitored payment options");
  }
  const limit = options.limit ?? 25;
  const budgetMs = options.budgetMs ?? 30000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 25 ||
      !Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 60000 ||
      (options.usePaymentQueue !== undefined &&
       typeof options.usePaymentQueue !== "boolean")) {
    throw new Error("Invalid monitored payment options");
  }
  // Capture values before awaiting monitoring I/O.
  const captured = {limit, budgetMs, usePaymentQueue: options.usePaymentQueue};
  return runWithFinancialRunnerHeartbeat(database, operation, async () => {
    const runner = await import("./runSelectedNewFlowPaymentBatch");
    return runner.runSelectedNewFlowPaymentBatch(operation, captured);
  });
}
