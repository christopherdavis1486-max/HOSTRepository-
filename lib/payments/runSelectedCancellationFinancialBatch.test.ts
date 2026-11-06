import { test, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { FinancialBatchJob, FinancialBatchResult } from "./runNewFlowFinancialBatch";
import type { CancellationFinancialOperation as Operation } from "./runSelectedCancellationFinancialBatch";

const entries = [
  ["reversal_execute", "ENABLE_TRANSFER_REVERSAL_EXECUTION"],
  ["reversal_reconcile", "ENABLE_TRANSFER_REVERSAL_RECONCILIATION"],
  ["settlement_execute", "ENABLE_CANCELLATION_HOST_SETTLEMENT_EXECUTION"],
  ["settlement_reconcile", "ENABLE_CANCELLATION_HOST_SETTLEMENT_RECONCILIATION"],
] as const;

let run: typeof import("./runSelectedCancellationFinancialBatch").runSelectedCancellationFinancialBatch;
let events: unknown[][];
let now: number;
let saved: Map<string, string | undefined>;
let restoreClock: () => void;
let id: string;
let expired: string[];
let selectHook: (operation: Operation) => Promise<FinancialBatchJob[]>;
let expiryHook: () => Promise<string[]>;
let dispatchHook: (jobs: FinancialBatchJob[]) => Promise<FinancialBatchResult[]>;

function enableOnly(operation: Operation) {
  for (const [candidate, flag] of entries) {
    if (candidate === operation) process.env[flag] = "true";
    else delete process.env[flag];
  }
}
function isReconciliation(operation: Operation) {
  return operation === "reversal_reconcile" || operation === "settlement_reconcile";
}
async function select(operation: Operation, limit: number) {
  events.push(["select", operation, limit]);
  return selectHook(operation);
}

before(async () => {
  mock.module("../payouts/selectTransferReversalJobs", {
    namedExports: { selectTransferReversalJobs: select },
  });
  mock.module("../payouts/selectCancellationSettlementJobs", {
    namedExports: { selectCancellationSettlementJobs: select },
  });
  mock.module("./flagExpiredNewFlowFinancialExecutions", {
    namedExports: {
      flagExpiredNewFlowFinancialExecutions: async (operation: Operation, limit: number) => {
        events.push(["expire", operation, limit]);
        return expiryHook();
      },
    },
  });
  mock.module("./runNewFlowFinancialBatch", {
    namedExports: {
      runNewFlowFinancialBatch: async (jobs: FinancialBatchJob[], options: { budgetMs: number }) => {
        events.push(["dispatch", jobs, options]);
        return dispatchHook(jobs);
      },
    },
  });
  ({ runSelectedCancellationFinancialBatch: run } =
    await import("./runSelectedCancellationFinancialBatch"));
});

beforeEach(() => {
  saved = new Map(entries.map(([, flag]) => [flag, process.env[flag]]));
  for (const [, flag] of entries) delete process.env[flag];
  events = [];
  now = 100;
  const clock = mock.method(performance, "now", () => now);
  restoreClock = () => clock.mock.restore();
  id = crypto.randomUUID();
  expired = [crypto.randomUUID()];
  selectHook = async operation => [{ operation, id }];
  expiryHook = async () => expired;
  dispatchHook = async jobs => jobs.map(job => ({
    ...job, status: "dispatched", recorded: false,
  }));
});
afterEach(() => {
  restoreClock();
  for (const [flag, value] of saved) {
    if (value === undefined) delete process.env[flag];
    else process.env[flag] = value;
  }
});

test("cancellation runner validates all inputs before phases", async () => {
  for (const operation of ["unknown", "__proto__", "constructor", null, undefined]) {
    await assert.rejects(run(operation as any), /Invalid cancellation financial operation/);
  }
  for (const limit of [0, -1, 1.5, NaN, Infinity, 26]) {
    await assert.rejects(run("reversal_execute", { limit }), /Invalid cancellation financial selection limit/);
  }
  for (const budgetMs of [0, -1, 1.5, NaN, Infinity, 60001]) {
    await assert.rejects(run("reversal_execute", { budgetMs }), /Invalid financial batch time budget/);
  }
  assert.deepEqual(events, []);
});

for (const [operation, flag] of entries) {
  test("cancellation runner refuses non-true gate: " + operation, async () => {
    for (const value of [undefined, "", "false", "1", "TRUE", " true", "true "]) {
      if (value === undefined) delete process.env[flag];
      else process.env[flag] = value;
      assert.deepEqual(await run(operation), {
        status: "disabled", expiredIds: [], results: [],
      });
    }
    assert.deepEqual(events, []);
  });

  test("cancellation runner orders only its enabled phases: " + operation, async () => {
    enableOnly(operation);
    for (const [other] of entries) {
      if (other !== operation) assert.equal((await run(other)).status, "disabled");
    }
    const jobs = [{ operation, id }];
    assert.deepEqual(await run(operation), {
      status: "completed",
      expiredIds: isReconciliation(operation) ? expired : [],
      results: [{ operation, id, status: "dispatched", recorded: false }],
    });
    assert.deepEqual(events, [
      ...(isReconciliation(operation) ? [["expire", operation, 25]] : []),
      ["select", operation, 25],
      ["dispatch", jobs, { budgetMs: 30000 }],
    ]);
  });

  test("cancellation runner deducts selection time: " + operation, async () => {
    enableOnly(operation);
    selectHook = async selected => { now += 25.5; return [{ operation: selected, id }]; };
    await run(operation, { limit: 3, budgetMs: 100 });
    assert.deepEqual(events.at(-1), [
      "dispatch", [{ operation, id }], { budgetMs: 74 },
    ]);
    assert.ok(events.some(event => event[0] === "select" && event[2] === 3));
  });

  test("cancellation runner stops after selection exhausts budget: " + operation, async () => {
    enableOnly(operation);
    selectHook = async selected => { now += 99.5; return [{ operation: selected, id }]; };
    assert.deepEqual(await run(operation, { budgetMs: 100 }), {
      status: "budget_exhausted",
      expiredIds: isReconciliation(operation) ? expired : [],
      results: [{ operation, id, status: "budget_exhausted" }],
    });
    assert.equal(events.some(event => event[0] === "dispatch"), false);
  });

  test("cancellation runner rechecks gate after selection: " + operation, async () => {
    enableOnly(operation);
    selectHook = async selected => {
      delete process.env[flag];
      return [{ operation: selected, id }];
    };
    assert.deepEqual(await run(operation), {
      status: "disabled",
      expiredIds: isReconciliation(operation) ? expired : [],
      results: [{ operation, id, status: "disabled" }],
    });
    assert.equal(events.some(event => event[0] === "dispatch"), false);
  });

  test("cancellation runner preserves empty selection: " + operation, async () => {
    enableOnly(operation);
    selectHook = async () => [];
    const result = await run(operation);
    assert.equal(result.status, "completed");
    assert.deepEqual(result.results, []);
    assert.deepEqual(events.at(-1), ["dispatch", [], { budgetMs: 30000 }]);
  });

  test("cancellation runner propagates selection failure without retry: " + operation, async () => {
    enableOnly(operation);
    selectHook = async () => { throw new Error("Injected selection failure"); };
    await assert.rejects(run(operation), /Injected selection failure/);
    assert.equal(events.filter(event => event[0] === "select").length, 1);
    assert.equal(events.some(event => event[0] === "dispatch"), false);
  });

  test("cancellation runner never retries dispatch failure: " + operation, async () => {
    enableOnly(operation);
    dispatchHook = async () => { throw new Error("Injected dispatch failure"); };
    await assert.rejects(run(operation), /Injected dispatch failure/);
    assert.equal(events.filter(event => event[0] === "dispatch").length, 1);
  });

  if (operation === "reversal_reconcile" || operation === "settlement_reconcile") {
    test("cancellation runner stops when expiry exhausts budget: " + operation, async () => {
      enableOnly(operation);
      expiryHook = async () => { now += 100; return expired; };
      assert.deepEqual(await run(operation, { budgetMs: 100 }), {
        status: "budget_exhausted", expiredIds: expired, results: [],
      });
      assert.deepEqual(events, [["expire", operation, 25]]);
    });

    test("cancellation runner rechecks gate after expiry: " + operation, async () => {
      enableOnly(operation);
      expiryHook = async () => { delete process.env[flag]; return expired; };
      assert.deepEqual(await run(operation), {
        status: "disabled", expiredIds: expired, results: [],
      });
      assert.deepEqual(events, [["expire", operation, 25]]);
    });

    test("cancellation runner propagates expiry failure without retry: " + operation, async () => {
      enableOnly(operation);
      expiryHook = async () => { throw new Error("Injected expiry failure"); };
      await assert.rejects(run(operation), /Injected expiry failure/);
      assert.deepEqual(events, [["expire", operation, 25]]);
    });

    test("cancellation runner deducts both expiry and selection time: " + operation, async () => {
      enableOnly(operation);
      expiryHook = async () => { now += 20; return expired; };
      selectHook = async selected => { now += 10; return [{ operation: selected, id }]; };
      await run(operation, { budgetMs: 100 });
      assert.deepEqual(events.at(-1), [
        "dispatch", [{ operation, id }], { budgetMs: 70 },
      ]);
    });
  }
}
