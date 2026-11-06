import { isHostTransferExecutionEnabled } from "../config/featureFlags";
import { runNewFlowFinancialBatch, type FinancialBatchResult } from "../payments/runNewFlowFinancialBatch";
import { selectClaimableHostTransferIds, claimSelectedHostTransfer } from "./selectAndClaimHostTransfers";

export type SelectedHostTransferResult =
  | FinancialBatchResult
  | {
      operation: "transfer_execute";
      id: string;
      status: "not_claimed" | "claim_error";
    };

/**
 * Internal selection, first claim and sequential dispatch only.
 * Explicit queue opt-in persists cooldowns before claims.
 * Queue hints never reset or authorize financial ownership.
 * Feedback can fail after financial work commits; never redispatch for it.
 * Cooldowns persist if later claiming or dispatch stops or fails.
 * Never reclaims an existing owner or resets execution for retry.
 * A claim followed by interruption remains claimed for separate review.
 * The budget does not cancel an active query, claim or worker.
 * No API/cron wiring.
 */
export async function runSelectedHostTransferBatch(
  workerId: string,
  options: { limit?: number; budgetMs?: number; useTransferQueue?: boolean } = {}
): Promise<SelectedHostTransferResult[]> {
  if (typeof workerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(workerId)) {
    throw new Error("Invalid host transfer claim identity");
  }
  const limit = options.limit ?? 25;
  const budgetMs = options.budgetMs ?? 30000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("Invalid host transfer selection limit");
  }
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 60000) {
    throw new Error("Invalid financial batch time budget");
  }
  if (options.useTransferQueue !== undefined && typeof options.useTransferQueue !== "boolean") {
    throw new Error("Invalid host transfer queue option");
  }
  if (!isHostTransferExecutionEnabled()) return [];

  const started = performance.now();
  const remaining = () => Math.floor(budgetMs - (performance.now() - started));
  const queue = options.useTransferQueue === true ? await import("./hostTransferQueue") : null;
  const selection = queue
    ? await queue.selectHostTransferQueueJobs("transfer_execute", limit) : null;
  const ids = selection ? selection.jobs.map(job => job.id)
    : await selectClaimableHostTransferIds(limit);
  const results: SelectedHostTransferResult[] = [];

  for (const id of ids) {
    const job = { operation: "transfer_execute" as const, id };
    if (remaining() < 1) {
      results.push({ ...job, status: "budget_exhausted" });
      continue;
    }
    if (!isHostTransferExecutionEnabled()) {
      results.push({ ...job, status: "disabled" });
      continue;
    }

    let claimed: boolean;
    try {
      claimed = await claimSelectedHostTransfer(id, workerId);
    } catch {
      // A failed/uncertain claim is never automatically retried.
      results.push({ ...job, status: "claim_error" });
      continue;
    }
    if (!claimed) {
      results.push({ ...job, status: "not_claimed" });
      continue;
    }

    const left = remaining();
    if (left < 1) {
      results.push({ ...job, status: "budget_exhausted" });
      continue;
    }
    const dispatched = await runNewFlowFinancialBatch(
      [job], { budgetMs: Math.min(left, budgetMs) }
    );
    results.push(...dispatched);
  }
  if (queue && selection) {
    await queue.recordHostTransferQueueResults(
      "transfer_execute", selection.reviewToken, results
    );
  }
  return results;
}
