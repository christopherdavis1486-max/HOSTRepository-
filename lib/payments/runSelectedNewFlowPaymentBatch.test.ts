import { test, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { FinancialBatchJob, FinancialBatchResult } from "./runNewFlowFinancialBatch";
import type { PaymentSelectionOperation } from "./selectNewFlowPaymentJobs";

const entries = [
  ["payment_reconcile", "ENABLE_NEW_FLOW_PAYMENT_RECONCILIATION"],
  ["missing_refund_recover", "ENABLE_MISSING_LATE_PAYMENT_REFUND_RECOVERY"],
] as const;

let run: typeof import("./runSelectedNewFlowPaymentBatch").runSelectedNewFlowPaymentBatch;
let selections: unknown[][];
let dispatches: { jobs: FinancialBatchJob[]; options: { budgetMs: number } }[];
let saved: Map<string, string | undefined>;
let now: number;
let restoreClock: () => void;
let id: string;
let selectHook: (operation: PaymentSelectionOperation) => Promise<FinancialBatchJob[]>;
let dispatchHook: (jobs: FinancialBatchJob[]) => Promise<FinancialBatchResult[]>;

before(async () => {
  mock.module("./selectNewFlowPaymentJobs", {
    namedExports: {
      selectNewFlowPaymentJobs: async (operation: PaymentSelectionOperation, limit: number) => {
        selections.push([operation, limit]);
        return selectHook(operation);
      },
    },
  });
  mock.module("./runNewFlowFinancialBatch", {
    namedExports: {
      runNewFlowFinancialBatch: async (
        jobs: FinancialBatchJob[], options: { budgetMs: number }
      ) => {
        dispatches.push({ jobs, options });
        return dispatchHook(jobs);
      },
    },
  });
  ({ runSelectedNewFlowPaymentBatch: run } = await import("./runSelectedNewFlowPaymentBatch"));
});

beforeEach(() => {
  saved = new Map(entries.map(([, flag]) => [flag, process.env[flag]]));
  for (const [, flag] of entries) delete process.env[flag];
  selections = [];
  dispatches = [];
  id = crypto.randomUUID();
  now = 100;
  const clock = mock.method(performance, "now", () => now);
  restoreClock = () => clock.mock.restore();
  selectHook = async operation => [{ operation, id }];
  dispatchHook = async jobs => jobs.map(job => ({
    ...job, status: "dispatched",
    ...(job.operation === "payment_reconcile" ? { recorded: false } : { reserved: false }),
  }));
});
afterEach(() => {
  restoreClock();
  for (const [flag, value] of saved) {
    if (value === undefined) delete process.env[flag];
    else process.env[flag] = value;
  }
});

test("selected payment runner validates options before selection", async () => {
  for (const operation of ["unknown", "__proto__", null, undefined]) {
    await assert.rejects(run(operation as any), /Invalid payment selection operation/);
  }
  for (const limit of [0, -1, 1.5, NaN, Infinity, 26]) {
    await assert.rejects(run("payment_reconcile", { limit }), /Invalid payment selection limit/);
  }
  for (const budgetMs of [0, -1, 1.5, NaN, Infinity, 60001]) {
    await assert.rejects(run("payment_reconcile", { budgetMs }), /Invalid financial batch time budget/);
  }
  assert.deepEqual(selections, []);
  assert.deepEqual(dispatches, []);
});

for (const [operation, flag] of entries) {
  test("selected payment runner requires its independent true gate: " + operation, async () => {
    const otherFlag = entries.find(([candidate]) => candidate !== operation)![1];
    process.env[otherFlag] = "true";
    for (const value of [undefined, "", "false", "1", "TRUE", " true", "true "]) {
      if (value === undefined) delete process.env[flag];
      else process.env[flag] = value;
      assert.deepEqual(await run(operation), []);
    }
    assert.deepEqual(selections, []);
    assert.deepEqual(dispatches, []);
  });

  test("selected payment runner preserves false outcomes and defaults: " + operation, async () => {
    process.env[flag] = "true";
    const jobs = [{ operation, id }];
    assert.deepEqual(await run(operation), [{
      operation, id, status: "dispatched",
      ...(operation === "payment_reconcile" ? { recorded: false } : { reserved: false }),
    }]);
    assert.deepEqual(selections, [[operation, 25]]);
    assert.deepEqual(dispatches, [{ jobs, options: { budgetMs: 30000 } }]);
  });

  test("selected payment runner passes custom bounds: " + operation, async () => {
    process.env[flag] = "true";
    await run(operation, { limit: 3, budgetMs: 60000 });
    assert.deepEqual(selections, [[operation, 3]]);
    assert.equal(dispatches[0].options.budgetMs, 60000);
  });

  test("selected payment runner deducts selection duration: " + operation, async () => {
    process.env[flag] = "true";
    selectHook = async selected => { now += 25.5; return [{ operation: selected, id }]; };
    await run(operation, { budgetMs: 100 });
    assert.equal(dispatches[0].options.budgetMs, 74);
  });

  for (const elapsed of [100, 99.5]) {
    test("selected payment runner blocks exhausted budget: " + operation + " " + elapsed, async () => {
      process.env[flag] = "true";
      selectHook = async selected => {
        now += elapsed;
        return [{ operation: selected, id }];
      };
      assert.deepEqual(await run(operation, { budgetMs: 100 }), [
        { operation, id, status: "budget_exhausted" },
      ]);
      assert.deepEqual(dispatches, []);
    });
  }

  test("selected payment runner rechecks gate after selection: " + operation, async () => {
    process.env[flag] = "true";
    selectHook = async selected => {
      delete process.env[flag];
      return [{ operation: selected, id }];
    };
    assert.deepEqual(await run(operation), [{ operation, id, status: "disabled" }]);
    assert.deepEqual(dispatches, []);
  });

  test("selected payment runner preserves empty selection: " + operation, async () => {
    process.env[flag] = "true";
    selectHook = async () => [];
    assert.deepEqual(await run(operation), []);
    assert.deepEqual(dispatches, [{ jobs: [], options: { budgetMs: 30000 } }]);
  });

  test("selected payment runner propagates selection failure without retry: " + operation, async () => {
    process.env[flag] = "true";
    selectHook = async () => { throw new Error("Injected selection failure"); };
    await assert.rejects(run(operation), /Injected selection failure/);
    assert.equal(selections.length, 1);
    assert.deepEqual(dispatches, []);
  });

  test("selected payment runner never retries failed dispatch: " + operation, async () => {
    process.env[flag] = "true";
    dispatchHook = async () => { throw new Error("Injected dispatch failure"); };
    await assert.rejects(run(operation), /Injected dispatch failure/);
    assert.equal(selections.length, 1);
    assert.equal(dispatches.length, 1);
  });

  test("selected payment runner awaits selection before dispatch: " + operation, async () => {
    process.env[flag] = "true";
    let finish!: (jobs: FinancialBatchJob[]) => void;
    selectHook = () => new Promise(resolve => { finish = resolve; });
    const pending = run(operation);
    assert.equal(selections.length, 1);
    assert.deepEqual(dispatches, []);
    finish([{ operation, id }]);
    await pending;
    assert.equal(dispatches.length, 1);
  });
}
