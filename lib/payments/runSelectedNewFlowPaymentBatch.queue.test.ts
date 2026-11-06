import { test, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { FinancialBatchJob, FinancialBatchResult } from "./runNewFlowFinancialBatch";

type Operation = "payment_reconcile" | "missing_refund_recover";
let run: typeof import("./runSelectedNewFlowPaymentBatch").runSelectedNewFlowPaymentBatch;
let events: unknown[][];
let jobs: FinancialBatchJob[];
let results: FinancialBatchResult[];
let selectHandler: () => Promise<void>;
let dispatchHandler: () => Promise<void>;
let feedbackHandler: () => Promise<void>;
let now: number;
let clock: ReturnType<typeof mock.method>;
let saved: (string | undefined)[];
const token = crypto.randomUUID();
const flags = [
  "ENABLE_NEW_FLOW_PAYMENT_RECONCILIATION",
  "ENABLE_MISSING_LATE_PAYMENT_REFUND_RECOVERY",
];

before(async () => {
  mock.module("./selectNewFlowPaymentJobs", {
    namedExports: { selectNewFlowPaymentJobs: async (...args: unknown[]) => {
      events.push(["ordinary", ...args]);
      return jobs;
    } },
  });
  mock.module("./newFlowPaymentQueue", {
    namedExports: {
      selectNewFlowPaymentQueueJobs: async (...args: unknown[]) => {
        events.push(["queue", ...args]);
        await selectHandler();
        return { reviewToken: token, jobs };
      },
      recordNewFlowPaymentQueueResults: async (...args: unknown[]) => {
        events.push(["feedback", ...args]);
        await feedbackHandler();
      },
    },
  });
  mock.module("./runNewFlowFinancialBatch", {
    namedExports: { runNewFlowFinancialBatch: async (...args: unknown[]) => {
      events.push(["dispatch", ...args]);
      await dispatchHandler();
      return results;
    } },
  });
  ({ runSelectedNewFlowPaymentBatch: run } = await import("./runSelectedNewFlowPaymentBatch"));
});
beforeEach(() => {
  saved = flags.map(flag => process.env[flag]);
  for (const flag of flags) process.env[flag] = "true";
  events = [];
  jobs = [];
  results = [];
  now = 100;
  clock = mock.method(performance, "now", () => now);
  selectHandler = dispatchHandler = feedbackHandler = async () => {};
});
afterEach(() => {
  clock.mock.restore();
  flags.forEach((flag, index) => {
    if (saved[index] === undefined) delete process.env[flag];
    else process.env[flag] = saved[index];
  });
});

test("payment queue runner validates its option before any phase", async () => {
  for (const value of [null, "true", 1, {}, []]) {
    await assert.rejects(
      run("payment_reconcile", { usePaymentQueue: value as any }),
      /Invalid payment queue option/
    );
  }
  assert.deepEqual(events, []);
});

for (const operation of ["payment_reconcile", "missing_refund_recover"] as const) {
  const flag = operation === "payment_reconcile" ? flags[0] : flags[1];
  function prepare() {
    jobs = [{ operation, id: crypto.randomUUID() }];
    results = [{
      ...jobs[0], status: "dispatched",
      ...(operation === "payment_reconcile" ? { recorded: false } : { reserved: false }),
    }];
  }

  test("payment queue runner orders selection, dispatch and feedback: " + operation, async () => {
    prepare();
    assert.deepEqual(await run(operation, { usePaymentQueue: true }), results);
    assert.deepEqual(events, [
      ["queue", operation, 25],
      ["dispatch", jobs, { budgetMs: 30000 }],
      ["feedback", operation, token, results],
    ]);
  });

  test("payment queue runner retains ordinary selection when false: " + operation, async () => {
    prepare();
    await run(operation, { usePaymentQueue: false });
    assert.deepEqual(events, [
      ["ordinary", operation, 25],
      ["dispatch", jobs, { budgetMs: 30000 }],
    ]);
  });

  test("payment queue runner refuses disabled gates before queue access: " + operation, async () => {
    delete process.env[flag];
    assert.deepEqual(await run(operation, { usePaymentQueue: true }), []);
    assert.deepEqual(events, []);
  });

  test("payment queue runner deducts selection time and passes custom bounds: " + operation, async () => {
    prepare();
    selectHandler = async () => { now += 25.5; };
    await run(operation, { limit: 3, budgetMs: 100, usePaymentQueue: true });
    assert.deepEqual(events[0], ["queue", operation, 3]);
    assert.deepEqual(events[1], ["dispatch", jobs, { budgetMs: 74 }]);
  });

  test("payment queue runner stops after selection exhausts budget: " + operation, async () => {
    prepare();
    selectHandler = async () => { now += 100; };
    assert.deepEqual(await run(operation, { budgetMs: 100, usePaymentQueue: true }),
      [{ ...jobs[0], status: "budget_exhausted" }]);
    assert.deepEqual(events, [["queue", operation, 25]]);
  });

  test("payment queue runner stops when gate turns off after selection: " + operation, async () => {
    prepare();
    selectHandler = async () => { delete process.env[flag]; };
    assert.deepEqual(await run(operation, { usePaymentQueue: true }),
      [{ ...jobs[0], status: "disabled" }]);
    assert.deepEqual(events, [["queue", operation, 25]]);
  });

  test("payment queue runner propagates selection failure without fallback: " + operation, async () => {
    selectHandler = async () => { throw new Error("Injected queue selection failure"); };
    await assert.rejects(run(operation, { usePaymentQueue: true }), /queue selection failure/);
    assert.deepEqual(events, [["queue", operation, 25]]);
  });

  test("payment queue runner never retries a thrown dispatch: " + operation, async () => {
    prepare();
    dispatchHandler = async () => { throw new Error("Injected dispatch failure"); };
    await assert.rejects(run(operation, { usePaymentQueue: true }), /dispatch failure/);
    assert.deepEqual(events.map(event => event[0]), ["queue", "dispatch"]);
  });

  test("payment queue runner exposes feedback failure without redispatching: " + operation, async () => {
    prepare();
    feedbackHandler = async () => { throw new Error("Injected feedback failure"); };
    await assert.rejects(run(operation, { usePaymentQueue: true }), /feedback failure/);
    assert.deepEqual(events.map(event => event[0]), ["queue", "dispatch", "feedback"]);
  });

  test("payment queue runner preserves empty batches and mixed outcome statuses: " + operation, async () => {
    assert.deepEqual(await run(operation, { usePaymentQueue: true }), []);
    assert.deepEqual(events.at(-1), ["feedback", operation, token, []]);
    events = [];
    prepare();
    results = ["error", "disabled", "budget_exhausted"].map(status => ({
      operation, id: crypto.randomUUID(), status,
    })) as FinancialBatchResult[];
    assert.deepEqual(await run(operation, { usePaymentQueue: true }), results);
    assert.deepEqual(events.at(-1), ["feedback", operation, token, results]);
  });
}
