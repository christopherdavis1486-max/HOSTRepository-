import type { Pool } from "pg";
import type { runSelectedCancellationFinancialBatch } from "./runSelectedCancellationFinancialBatch";
import { runWithFinancialRunnerHeartbeat } from "./runWithFinancialRunnerHeartbeat";

type Runner = typeof runSelectedCancellationFinancialBatch;
type Operation = Parameters<Runner>[0];
type Options = NonNullable<Parameters<Runner>[1]>;

/** Explicit opt-in only. Inspect execution and heartbeat outcomes separately.
 * Financial gates and authorization remain inside the existing runner.
 * No scheduling or retries; heartbeat timing is outside the runner's soft budget.
 */
export async function runMonitoredCancellationFinancialBatch(
  database: Pick<Pool, "query">,
  operation: Operation,
  options: Options = {}
) {
  if (!["reversal_execute", "reversal_reconcile",
        "settlement_execute", "settlement_reconcile"].includes(operation)) {
    throw new Error("Invalid monitored cancellation operation");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Invalid monitored cancellation options");
  }
  const limit = options.limit ?? 25;
  const budgetMs = options.budgetMs ?? 30000;
  const useSettlementQueue = options.useSettlementQueue;
  const useReversalQueue = options.useReversalQueue;
  if (!Number.isInteger(limit) || limit < 1 || limit > 25 ||
      !Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 60000 ||
      (useSettlementQueue !== undefined && typeof useSettlementQueue !== "boolean") ||
      (useReversalQueue !== undefined && typeof useReversalQueue !== "boolean") ||
      (useSettlementQueue === true && !operation.startsWith("settlement_")) ||
      (useReversalQueue === true && !operation.startsWith("reversal_"))) {
    throw new Error("Invalid monitored cancellation options");
  }
  const captured = {limit, budgetMs, useSettlementQueue, useReversalQueue};
  return runWithFinancialRunnerHeartbeat(database, operation, async () => {
    const runner = await import("./runSelectedCancellationFinancialBatch");
    return runner.runSelectedCancellationFinancialBatch(operation, captured);
  });
}
