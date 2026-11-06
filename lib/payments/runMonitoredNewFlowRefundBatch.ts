import type { Pool } from "pg";
import type { runSelectedNewFlowRefundBatch } from "./runSelectedNewFlowRefundBatch";
import { runWithFinancialRunnerHeartbeat } from "./runWithFinancialRunnerHeartbeat";

type Runner = typeof runSelectedNewFlowRefundBatch;
type Operation = Parameters<Runner>[0];
type Options = NonNullable<Parameters<Runner>[1]>;

/**
 * Explicit monitored entry point for refund selection.
 * Existing direct callers remain unchanged. No scheduler or retry.
 * Callers must inspect both execution and heartbeat outcomes.
 * Financial gates and authorization remain inside the existing runner.
 */
export async function runMonitoredNewFlowRefundBatch(
  database: Pick<Pool, "query">,
  operation: Operation,
  options: Options = {}
) {
  if (operation !== "refund_execute" && operation !== "refund_reconcile") {
    throw new Error("Invalid monitored refund operation");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Invalid monitored refund options");
  }
  const limit = options.limit ?? 25;
  const budgetMs = options.budgetMs ?? 30000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 25 ||
      !Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 60000 ||
      (options.useRefundQueue !== undefined &&
       typeof options.useRefundQueue !== "boolean")) {
    throw new Error("Invalid monitored refund options");
  }
  // Capture values before awaiting monitoring I/O.
  const captured = {limit, budgetMs, useRefundQueue: options.useRefundQueue};
  return runWithFinancialRunnerHeartbeat(database, operation, async () => {
    const runner = await import("./runSelectedNewFlowRefundBatch");
    return runner.runSelectedNewFlowRefundBatch(operation, captured);
  });
}
