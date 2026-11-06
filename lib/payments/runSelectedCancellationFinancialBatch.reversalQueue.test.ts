import { test, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { FinancialBatchJob, FinancialBatchResult } from "./runNewFlowFinancialBatch";

type Operation = "reversal_execute" | "reversal_reconcile";
const operations: Operation[] = ["reversal_execute", "reversal_reconcile"];
const flags = [
  "ENABLE_TRANSFER_REVERSAL_EXECUTION",
  "ENABLE_TRANSFER_REVERSAL_RECONCILIATION",
  "ENABLE_CANCELLATION_HOST_SETTLEMENT_EXECUTION",
  "ENABLE_CANCELLATION_HOST_SETTLEMENT_RECONCILIATION",
];
let run: typeof import("./runSelectedCancellationFinancialBatch").runSelectedCancellationFinancialBatch;
let saved: (string | undefined)[];
let events: string[];
let jobs: FinancialBatchJob[];
let token: string;
let feedbackError: boolean;
let selectionError: boolean;
let disableAfterSelection: boolean;
let batchError: boolean;
let feedback: { operation: string; token: string; results: readonly FinancialBatchResult[] }[];
let expired: string[];
let afterSelection: () => void;

function enable(operation: Operation) {
  process.env[flags[operation === "reversal_execute" ? 0 : 1]] = "true";
}
before(async () => {
  mock.module("../payouts/selectTransferReversalJobs", { namedExports: {
    selectTransferReversalJobs: async () => {
      events.push("ordinary");
      return jobs;
    },
  }});
  mock.module("../payouts/selectCancellationSettlementJobs", { namedExports: {
    selectCancellationSettlementJobs: async () => {
      events.push("settlement_ordinary");
      return jobs;
    },
  }});
  mock.module("./flagExpiredNewFlowFinancialExecutions", { namedExports: {
    flagExpiredNewFlowFinancialExecutions: async () => {
      events.push("expiry");
      return expired;
    },
  }});
  mock.module("../payouts/transferReversalQueue", { namedExports: {
    selectTransferReversalQueueJobs: async (operation: string, limit: number) => {
      events.push("queue");
      assert.ok(operation.startsWith("reversal_"));
      assert.equal(limit, 2);
      if (selectionError) throw new Error("selection failed");
      if (disableAfterSelection) flags.forEach(flag => delete process.env[flag]);
      afterSelection();
      return { reviewToken: token, jobs };
    },
    recordTransferReversalQueueResults: async (
      operation: string, reviewToken: string, results: readonly FinancialBatchResult[]
    ) => {
      events.push("feedback");
      feedback.push({operation, token:reviewToken, results});
      if (feedbackError) throw new Error("feedback failed after financial completion");
    },
  }});
  mock.module("./runNewFlowFinancialBatch", { namedExports: {
    runNewFlowFinancialBatch: async (selected: FinancialBatchJob[]) => {
      events.push("dispatch");
      assert.deepEqual(selected, jobs);
      if (batchError) throw new Error("dispatcher failed");
      return selected.map(job => ({
        ...job, status:"dispatched" as const, attempted:false, recorded:false,
      }));
    },
  }});
  ({ runSelectedCancellationFinancialBatch: run } =
    await import("./runSelectedCancellationFinancialBatch"));
});
beforeEach(() => {
  saved = flags.map(flag => process.env[flag]);
  flags.forEach(flag => delete process.env[flag]);
  events = [];
  jobs = [];
  token = crypto.randomUUID();
  feedbackError = false;
  selectionError = false;
  disableAfterSelection = false;
  batchError = false;
  feedback = [];
  expired = [crypto.randomUUID()];
  afterSelection = () => {};
});
afterEach(() => {
  flags.forEach((flag, index) => {
    if (saved[index] === undefined) delete process.env[flag];
    else process.env[flag] = saved[index];
  });
});

for (const operation of operations) {
  function prepare() {
    enable(operation);
    jobs = [{operation, id:crypto.randomUUID()}];
  }
  const prefix = operation === "reversal_reconcile" ? ["expiry"] : [];

  test(`${operation}: queue opt-in selects, dispatches and records once`, async () => {
    prepare();
    const result = await run(operation, {limit:2, useReversalQueue:true});
    assert.equal(result.status, "completed");
    assert.deepEqual(events, [...prefix, "queue", "dispatch", "feedback"]);
    assert.deepEqual(result.expiredIds, prefix.length ? expired : []);
    assert.equal(feedback.length, 1);
    assert.equal(feedback[0].operation, operation);
    assert.equal(feedback[0].token, token);
    assert.deepEqual(feedback[0].results, result.results);
    assert.equal(result.results[0].recorded, false);
  });
  test(`${operation}: default retains ordinary selection`, async () => {
    prepare();
    await run(operation, {limit:2});
    assert.deepEqual(events, [...prefix, "ordinary", "dispatch"]);
    assert.equal(feedback.length, 0);
  });
  test(`${operation}: explicit false retains ordinary selection`, async () => {
    prepare();
    await run(operation, {limit:2, useReversalQueue:false});
    assert.deepEqual(events, [...prefix, "ordinary", "dispatch"]);
  });
  test(`${operation}: disabled gate performs no work`, async () => {
    const result = await run(operation, {limit:2, useReversalQueue:true});
    assert.equal(result.status, "disabled");
    assert.deepEqual(events, []);
  });
  test(`${operation}: feedback failure never redispatches`, async () => {
    prepare();
    feedbackError = true;
    await assert.rejects(
      run(operation, {limit:2, useReversalQueue:true}),
      /feedback failed after financial completion/
    );
    assert.deepEqual(events, [...prefix, "queue", "dispatch", "feedback"]);
    assert.equal(events.filter(event => event === "dispatch").length, 1);
  });
  test(`${operation}: selection failure prevents dispatch`, async () => {
    prepare();
    selectionError = true;
    await assert.rejects(run(operation, {limit:2, useReversalQueue:true}), /selection failed/);
    assert.deepEqual(events, [...prefix, "queue"]);
  });
  test(`${operation}: post-selection gate disable retains cooldown without dispatch`, async () => {
    prepare();
    disableAfterSelection = true;
    const result = await run(operation, {limit:2, useReversalQueue:true});
    assert.equal(result.status, "disabled");
    assert.deepEqual(events, [...prefix, "queue"]);
    assert.equal(result.results[0].status, "disabled");
  });
  test(`${operation}: exhausted budget after selection prevents dispatch`, async () => {
    prepare();
    let now = 0;
    const timer = mock.method(performance, "now", () => now);
    try {
      afterSelection = () => { now = 101; };
      const result = await run(operation, {
        limit:2, budgetMs:100, useReversalQueue:true,
      });
      assert.equal(result.status, "budget_exhausted");
      assert.equal(result.results[0].status, "budget_exhausted");
      assert.deepEqual(events, [...prefix, "queue"]);
    } finally {
      timer.mock.restore();
    }
  });
  test(`${operation}: dispatcher failure does not retry`, async () => {
    prepare();
    batchError = true;
    await assert.rejects(run(operation, {limit:2, useReversalQueue:true}), /dispatcher failed/);
    assert.deepEqual(events, [...prefix, "queue", "dispatch"]);
  });
}
test("queue options reject invalid types and operation combinations before work", async () => {
  await assert.rejects(run("reversal_execute", {
    useReversalQueue:"true" as unknown as boolean,
  }), /Invalid reversal queue option/);
  await assert.rejects(run("settlement_execute", {useReversalQueue:true}), /requires a reversal/);
  await assert.rejects(run("reversal_execute", {useSettlementQueue:true}), /requires a settlement/);
  await assert.rejects(run("reversal_execute", {
    useReversalQueue:true, useSettlementQueue:true,
  }), /requires a settlement/);
  assert.deepEqual(events, []);
});
test("settlement default selection remains unchanged", async () => {
  process.env.ENABLE_CANCELLATION_HOST_SETTLEMENT_EXECUTION = "true";
  jobs = [{operation:"settlement_execute", id:crypto.randomUUID()}];
  const result = await run("settlement_execute", {limit:2});
  assert.equal(result.status, "completed");
  assert.deepEqual(events, ["settlement_ordinary", "dispatch"]);
});
