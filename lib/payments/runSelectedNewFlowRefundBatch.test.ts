import { test, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { FinancialBatchJob, FinancialBatchResult } from "./runNewFlowFinancialBatch";

let run: typeof import("./runSelectedNewFlowRefundBatch").runSelectedNewFlowRefundBatch;
let selections: unknown[][];
let dispatches: { jobs: FinancialBatchJob[]; options: { budgetMs: number } }[];
let jobs: FinancialBatchJob[];
let outcome: FinancialBatchResult[];
let selectHandler: () => Promise<FinancialBatchJob[]>;
let dispatchHandler: () => Promise<FinancialBatchResult[]>;
let now: number;
let restoreClock: () => void;

before(async () => {
  mock.module("./selectNewFlowRefundJobs", {
    namedExports: {
      selectNewFlowRefundJobs: async (...args: unknown[]) => {
        selections.push(args);
        return selectHandler();
      },
    },
  });
  mock.module("./runNewFlowFinancialBatch", {
    namedExports: {
      runNewFlowFinancialBatch: async (
        selected: FinancialBatchJob[], options: { budgetMs: number }
      ) => {
        dispatches.push({ jobs: selected, options });
        return dispatchHandler();
      },
    },
  });
  ({ runSelectedNewFlowRefundBatch: run } = await import("./runSelectedNewFlowRefundBatch"));
});
beforeEach(() => {
  now = 100;
  const clock = mock.method(performance, "now", () => now);
  restoreClock = () => clock.mock.restore();
  selections = [];
  dispatches = [];
  jobs = [{ operation: "refund_execute", id: crypto.randomUUID() }];
  outcome = [{ ...jobs[0], status: "dispatched", recorded: false }];
  selectHandler = async () => jobs;
  dispatchHandler = async () => outcome;
});
afterEach(() => { restoreClock(); });

test("selected refund runner validates all options before selection", async () => {
  await assert.rejects(run("unknown" as any), /Invalid refund selection operation/);
  for (const limit of [0, -1, 1.5, NaN, Infinity, 26]) {
    await assert.rejects(run("refund_execute", { limit }), /Invalid refund selection limit/);
  }
  for (const budgetMs of [0, -1, 1.5, NaN, Infinity, 60001]) {
    await assert.rejects(run("refund_execute", { budgetMs }), /Invalid financial batch time budget/);
  }
  assert.deepEqual(selections, []);
  assert.deepEqual(dispatches, []);
});

test("selected refund runner uses bounded defaults and preserves outcomes", async () => {
  assert.deepEqual(await run("refund_execute"), outcome);
  assert.deepEqual(selections, [["refund_execute", 25]]);
  assert.deepEqual(dispatches, [{ jobs, options: { budgetMs: 30000 } }]);
});

test("selected refund runner selects reconciliation independently", async () => {
  jobs = [{ operation: "refund_reconcile", id: crypto.randomUUID() }];
  outcome = [{ ...jobs[0], status: "disabled" }];
  assert.deepEqual(await run("refund_reconcile", { limit: 3, budgetMs: 200 }), outcome);
  assert.deepEqual(selections, [["refund_reconcile", 3]]);
  assert.deepEqual(dispatches, [{ jobs, options: { budgetMs: 200 } }]);
});

test("selected refund runner deducts selection time before dispatch", async () => {
  selectHandler = async () => { now += 25.5; return jobs; };
  await run("refund_execute", { budgetMs: 100 });
  assert.equal(dispatches[0].options.budgetMs, 74);
});

test("selected refund runner does not dispatch when selection exhausts budget", async () => {
  selectHandler = async () => { now += 100; return jobs; };
  assert.deepEqual(await run("refund_execute", { budgetMs: 100 }), [
    { ...jobs[0], status: "budget_exhausted" },
  ]);
  assert.deepEqual(dispatches, []);
});

test("selected refund runner refuses a remaining budget below one millisecond", async () => {
  selectHandler = async () => { now += 99.5; return jobs; };
  assert.deepEqual(await run("refund_execute", { budgetMs: 100 }), [
    { ...jobs[0], status: "budget_exhausted" },
  ]);
  assert.deepEqual(dispatches, []);
});

test("selected refund runner preserves empty selection", async () => {
  jobs = [];
  outcome = [];
  assert.deepEqual(await run("refund_execute"), []);
  assert.deepEqual(dispatches, [{ jobs: [], options: { budgetMs: 30000 } }]);
});

test("selected refund runner propagates selection failure without dispatch or retry", async () => {
  selectHandler = async () => { throw new Error("Selection unavailable"); };
  await assert.rejects(run("refund_execute"), /Selection unavailable/);
  assert.equal(selections.length, 1);
  assert.deepEqual(dispatches, []);
});

test("selected refund runner does not retry a failed dispatch", async () => {
  dispatchHandler = async () => { throw new Error("Dispatch unavailable"); };
  await assert.rejects(run("refund_execute"), /Dispatch unavailable/);
  assert.equal(selections.length, 1);
  assert.equal(dispatches.length, 1);
});

test("selected refund runner awaits selection before dispatch", async () => {
  let completeSelection!: (value: FinancialBatchJob[]) => void;
  selectHandler = () => new Promise(resolve => { completeSelection = resolve; });
  const pending = run("refund_execute");
  assert.equal(selections.length, 1);
  assert.deepEqual(dispatches, []);
  completeSelection(jobs);
  assert.deepEqual(await pending, outcome);
  assert.equal(dispatches.length, 1);
});
