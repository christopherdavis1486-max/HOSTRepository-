import { test, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { FinancialBatchJob } from "./runNewFlowFinancialBatch";

type Operation = "settlement_execute" | "settlement_reconcile";
let run: typeof import("./runSelectedCancellationFinancialBatch").runSelectedCancellationFinancialBatch;
let events: unknown[][];
let jobs: FinancialBatchJob[];
let now: number;
let clock: ReturnType<typeof mock.method>;
let handler: () => Promise<FinancialBatchJob[]>;
let saved: (string | undefined)[];
const flags = [
  "ENABLE_CANCELLATION_HOST_SETTLEMENT_EXECUTION",
  "ENABLE_CANCELLATION_HOST_SETTLEMENT_RECONCILIATION",
];
const expiredId = crypto.randomUUID();

before(async () => {
  mock.module("../payouts/selectTransferReversalJobs", {
    namedExports: { selectTransferReversalJobs: async () => {
      throw new Error("Unexpected reversal selection");
    } },
  });
  mock.module("../payouts/selectCancellationSettlementJobs", {
    namedExports: { selectCancellationSettlementJobs: async (...args: unknown[]) => {
      events.push(["ordinary", ...args]);
      return jobs;
    } },
  });
  mock.module("../payouts/reviewCancellationSettlementQueue", {
    namedExports: { reviewCancellationSettlementQueue: async (...args: unknown[]) => {
      events.push(["queue", ...args]);
      return handler();
    } },
  });
  mock.module("./flagExpiredNewFlowFinancialExecutions", {
    namedExports: { flagExpiredNewFlowFinancialExecutions: async (...args: unknown[]) => {
      events.push(["expiry", ...args]);
      return [expiredId];
    } },
  });
  mock.module("./runNewFlowFinancialBatch", {
    namedExports: { runNewFlowFinancialBatch: async (
      selected: FinancialBatchJob[], options: { budgetMs: number }
    ) => {
      events.push(["dispatch", selected, options]);
      return selected.map(job => ({
        ...job, status: "dispatched", recorded: false,
      }));
    } },
  });
  ({ runSelectedCancellationFinancialBatch: run } =
    await import("./runSelectedCancellationFinancialBatch"));
});
beforeEach(() => {
  saved = flags.map(flag => process.env[flag]);
  for (const flag of flags) process.env[flag] = "true";
  events = [];
  jobs = [];
  now = 100;
  clock = mock.method(performance, "now", () => now);
  handler = async () => jobs;
});
afterEach(() => {
  clock.mock.restore();
  flags.forEach((flag, index) => {
    if (saved[index] === undefined) delete process.env[flag];
    else process.env[flag] = saved[index];
  });
});

test("queue runner validates its option before any phase", async () => {
  for (const value of [null, "true", 1, {}, []]) {
    await assert.rejects(
      run("settlement_execute", { useSettlementQueue: value as any }),
      /Invalid settlement queue option/
    );
  }
  for (const operation of ["reversal_execute", "reversal_reconcile"] as const) {
    await assert.rejects(
      run(operation, { useSettlementQueue: true }),
      /requires a settlement operation/
    );
  }
  assert.deepEqual(events, []);
});

for (const operation of ["settlement_execute", "settlement_reconcile"] as const) {
  function prepare() {
    jobs = [{ operation, id: crypto.randomUUID() }];
  }
  const flag = operation === "settlement_execute" ? flags[0] : flags[1];

  test("queue runner orders phases and preserves false outcomes: " + operation, async () => {
    prepare();
    const result = await run(operation, { limit: 3, budgetMs: 200, useSettlementQueue: true });
    assert.deepEqual(events, [
      ...(operation === "settlement_reconcile" ? [["expiry", operation, 3]] : []),
      ["queue", operation, 3],
      ["dispatch", jobs, { budgetMs: 200 }],
    ]);
    assert.deepEqual(result, {
      status: "completed",
      expiredIds: operation === "settlement_reconcile" ? [expiredId] : [],
      results: [{ ...jobs[0], status: "dispatched", recorded: false }],
    });
  });

  test("queue runner retains ordinary selection when option is false: " + operation, async () => {
    prepare();
    await run(operation, { useSettlementQueue: false });
    assert.ok(events.some(event => event[0] === "ordinary"));
    assert.equal(events.some(event => event[0] === "queue"), false);
  });

  test("queue runner refuses disabled gates before queue work: " + operation, async () => {
    delete process.env[flag];
    assert.deepEqual(await run(operation, { useSettlementQueue: true }), {
      status: "disabled", expiredIds: [], results: [],
    });
    assert.deepEqual(events, []);
  });

  test("queue runner deducts review duration from dispatch budget: " + operation, async () => {
    prepare();
    handler = async () => { now += 25.5; return jobs; };
    await run(operation, { budgetMs: 100, useSettlementQueue: true });
    assert.deepEqual(events.at(-1), ["dispatch", jobs, { budgetMs: 74 }]);
  });

  test("queue runner stops dispatch after review consumes budget: " + operation, async () => {
    prepare();
    handler = async () => { now += 100; return jobs; };
    const result = await run(operation, { budgetMs: 100, useSettlementQueue: true });
    assert.equal(result.status, "budget_exhausted");
    assert.deepEqual(result.results, [{ ...jobs[0], status: "budget_exhausted" }]);
    assert.equal(events.some(event => event[0] === "dispatch"), false);
  });

  test("queue runner rechecks its gate after review: " + operation, async () => {
    prepare();
    handler = async () => { delete process.env[flag]; return jobs; };
    const result = await run(operation, { useSettlementQueue: true });
    assert.equal(result.status, "disabled");
    assert.deepEqual(result.results, [{ ...jobs[0], status: "disabled" }]);
    assert.equal(events.some(event => event[0] === "dispatch"), false);
  });

  test("queue runner propagates review failure without fallback or retry: " + operation, async () => {
    handler = async () => { throw new Error("Injected queue failure"); };
    await assert.rejects(
      run(operation, { useSettlementQueue: true }), /Injected queue failure/
    );
    assert.equal(events.filter(event => event[0] === "queue").length, 1);
    assert.equal(events.some(event => ["ordinary", "dispatch"].includes(String(event[0]))), false);
  });
}
