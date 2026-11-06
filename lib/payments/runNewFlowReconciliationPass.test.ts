import { test, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { FinancialBatchJob, FinancialBatchResult } from "./runNewFlowFinancialBatch";

let run: typeof import("./runNewFlowReconciliationPass").runNewFlowReconciliationPass;
const entries = [
  ["refund_reconcile", "ENABLE_NEW_FLOW_REFUND_RECONCILIATION"],
  ["transfer_reconcile", "ENABLE_HOST_TRANSFER_RECONCILIATION"],
] as const;
let saved: Map<string, string | undefined>;
let events: unknown[][];
let expiredIds: string[];
let jobs: FinancialBatchJob[];
let results: FinancialBatchResult[];
let now: number;
let restoreClock: () => void;
let expiry: () => Promise<string[]>;
let selection: () => Promise<FinancialBatchJob[]>;
let dispatch: () => Promise<FinancialBatchResult[]>;

before(async () => {
  mock.module("./flagExpiredNewFlowFinancialExecutions", {
    namedExports: {
      flagExpiredNewFlowFinancialExecutions: async (...args: unknown[]) => {
        events.push(["expiry", ...args]);
        return expiry();
      },
    },
  });
  mock.module("./selectNewFlowRefundJobs", {
    namedExports: {
      selectNewFlowRefundJobs: async (...args: unknown[]) => {
        events.push(["refund_selection", ...args]);
        return selection();
      },
    },
  });
  mock.module("../payouts/selectHostTransferReconciliationJobs", {
    namedExports: {
      selectHostTransferReconciliationJobs: async (...args: unknown[]) => {
        events.push(["transfer_selection", ...args]);
        return selection();
      },
    },
  });
  mock.module("./runNewFlowFinancialBatch", {
    namedExports: {
      runNewFlowFinancialBatch: async (...args: unknown[]) => {
        events.push(["dispatch", ...args]);
        return dispatch();
      },
    },
  });
  ({ runNewFlowReconciliationPass: run } = await import("./runNewFlowReconciliationPass"));
});
beforeEach(() => {
  saved = new Map(entries.map(([, flag]) => [flag, process.env[flag]]));
  for (const [, flag] of entries) delete process.env[flag];
  events = [];
  expiredIds = [crypto.randomUUID()];
  jobs = [{ operation: "refund_reconcile", id: crypto.randomUUID() }];
  results = [{ ...jobs[0], status: "dispatched", recorded: false }];
  now = 100;
  const clock = mock.method(performance, "now", () => now);
  restoreClock = () => clock.mock.restore();
  expiry = async () => expiredIds;
  selection = async () => jobs;
  dispatch = async () => results;
});
afterEach(() => {
  restoreClock();
  for (const [flag, value] of saved) {
    if (value === undefined) delete process.env[flag];
    else process.env[flag] = value;
  }
});

test("reconciliation pass validates inputs before expiry", async () => {
  await assert.rejects(run("unknown" as any), /Invalid reconciliation pass operation/);
  for (const limit of [0, -1, 1.5, NaN, Infinity, 26]) {
    await assert.rejects(run("refund_reconcile", { limit }), /Invalid reconciliation pass limit/);
  }
  for (const budgetMs of [0, -1, 1.5, NaN, Infinity, 60001]) {
    await assert.rejects(run("refund_reconcile", { budgetMs }), /Invalid financial batch time budget/);
  }
  assert.deepEqual(events, []);
});

for (const [operation, flag] of entries) {
  test("reconciliation pass refuses non-true gate values: " + operation, async () => {
    for (const value of [undefined, "", "false", "1", "TRUE", " true", "true "]) {
      if (value === undefined) delete process.env[flag];
      else process.env[flag] = value;
      assert.deepEqual(await run(operation), { status: "disabled", expiredIds: [], results: [] });
    }
    assert.deepEqual(events, []);
  });

  test("reconciliation pass orders phases and selects only its resource: " + operation, async () => {
    process.env[flag] = "true";
    jobs = [{ operation, id: crypto.randomUUID() }];
    results = [{ ...jobs[0], status: "dispatched", recorded: false }];
    assert.deepEqual(await run(operation, { limit: 3 }), {
      status: "completed", expiredIds, results,
    });
    assert.deepEqual(events, [
      ["expiry", operation, 3],
      operation === "refund_reconcile"
        ? ["refund_selection", operation, 3] : ["transfer_selection", 3],
      ["dispatch", jobs, { budgetMs: 30000 }],
    ]);
  });

  test("reconciliation pass deducts expiry and selection time: " + operation, async () => {
    process.env[flag] = "true";
    expiry = async () => { now += 20; return expiredIds; };
    selection = async () => { now += 10.5; return jobs; };
    await run(operation, { budgetMs: 100 });
    assert.deepEqual(events.at(-1), ["dispatch", jobs, { budgetMs: 69 }]);
  });

  test("reconciliation pass stops after expiry exhausts budget: " + operation, async () => {
    process.env[flag] = "true";
    expiry = async () => { now += 100; return expiredIds; };
    assert.deepEqual(await run(operation, { budgetMs: 100 }), {
      status: "budget_exhausted", expiredIds, results: [],
    });
    assert.deepEqual(events, [["expiry", operation, 25]]);
  });

  test("reconciliation pass preserves expiry results when gate is disabled: " + operation, async () => {
    process.env[flag] = "true";
    expiry = async () => { delete process.env[flag]; return expiredIds; };
    assert.deepEqual(await run(operation), { status: "disabled", expiredIds, results: [] });
    assert.deepEqual(events, [["expiry", operation, 25]]);
  });

  test("reconciliation pass does not dispatch after selection exhausts budget: " + operation, async () => {
    process.env[flag] = "true";
    selection = async () => { now += 100; return jobs; };
    assert.deepEqual(await run(operation, { budgetMs: 100 }), {
      status: "budget_exhausted", expiredIds,
      results: jobs.map(job => ({ ...job, status: "budget_exhausted" })),
    });
    assert.equal(events.length, 2);
  });

  test("reconciliation pass preserves an empty queue: " + operation, async () => {
    process.env[flag] = "true";
    expiredIds = []; jobs = []; results = [];
    assert.deepEqual(await run(operation), { status: "completed", expiredIds: [], results: [] });
  });

  for (const phase of ["expiry", "selection", "dispatch"]) {
    test("reconciliation pass never retries failed " + phase + ": " + operation, async () => {
      process.env[flag] = "true";
      const fail = async (): Promise<never> => { throw new Error("Injected phase failure"); };
      if (phase === "expiry") expiry = fail;
      if (phase === "selection") selection = fail;
      if (phase === "dispatch") dispatch = fail;
      await assert.rejects(run(operation), /Injected phase failure/);
      assert.equal(events.length, phase === "expiry" ? 1 : phase === "selection" ? 2 : 3);
    });
  }
}
