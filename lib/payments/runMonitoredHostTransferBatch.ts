import type { Pool } from "pg";
import type { runSelectedHostTransferBatch } from "../payouts/runSelectedHostTransferBatch";
import { runWithFinancialRunnerHeartbeat } from "./runWithFinancialRunnerHeartbeat";

type Options = NonNullable<Parameters<typeof runSelectedHostTransferBatch>[1]>;
type Database = Pick<Pool, "query">;

function capture(options: Options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Invalid monitored transfer options");
  }
  const limit = options.limit ?? 25;
  const budgetMs = options.budgetMs ?? 30000;
  const useTransferQueue = options.useTransferQueue;
  if (!Number.isInteger(limit) || limit < 1 || limit > 25 ||
      !Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 60000 ||
      (useTransferQueue !== undefined && typeof useTransferQueue !== "boolean")) {
    throw new Error("Invalid monitored transfer options");
  }
  return {limit, budgetMs, useTransferQueue};
}

/** Explicit opt-in. Inspect execution and heartbeat outcomes separately.
 * Heartbeat I/O is outside the existing runner's soft budget. No retries.
 */
export async function runMonitoredHostTransferExecution(
  database: Database, workerId: string, options: Options = {}
) {
  if (typeof workerId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(workerId)) {
    throw new Error("Invalid monitored transfer claim identity");
  }
  const captured = capture(options);
  return runWithFinancialRunnerHeartbeat(database, "transfer_execute", async () => {
    const runner = await import("../payouts/runSelectedHostTransferBatch");
    return runner.runSelectedHostTransferBatch(workerId, captured);
  });
}

/** Uses the existing expiry -> selection -> reconciliation pass unchanged. */
export async function runMonitoredHostTransferReconciliation(
  database: Database, options: Options = {}
) {
  const captured = capture(options);
  return runWithFinancialRunnerHeartbeat(database, "transfer_reconcile", async () => {
    const runner = await import("./runNewFlowReconciliationPass");
    return runner.runNewFlowReconciliationPass("transfer_reconcile", captured);
  });
}
