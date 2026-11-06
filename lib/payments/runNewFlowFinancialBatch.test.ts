import { test, mock, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { FinancialBatchOperation } from "./runNewFlowFinancialBatch";

const entries = [
  ["refund_execute", "ENABLE_NEW_FLOW_REFUND_EXECUTION", "./executeNewFlowRefund", "executeNewFlowRefund"],
  ["refund_reconcile", "ENABLE_NEW_FLOW_REFUND_RECONCILIATION", "./reconcileNewFlowRefund", "reconcileNewFlowRefund"],
  ["transfer_execute", "ENABLE_HOST_TRANSFER_EXECUTION", "../payouts/hostTransfers", "attemptRelease"],
  ["transfer_reconcile", "ENABLE_HOST_TRANSFER_RECONCILIATION", "../payouts/reconcileHostTransfer", "reconcileHostTransfer"],
  ["reversal_execute", "ENABLE_TRANSFER_REVERSAL_EXECUTION", "../payouts/transferReversal", "executeReversal"],
  ["reversal_reconcile", "ENABLE_TRANSFER_REVERSAL_RECONCILIATION", "../payouts/reconcileTransferReversal", "reconcileTransferReversal"],
  ["settlement_execute", "ENABLE_CANCELLATION_HOST_SETTLEMENT_EXECUTION", "../payouts/executeCancellationHostSettlement", "executeCancellationHostSettlement"],
  ["settlement_reconcile", "ENABLE_CANCELLATION_HOST_SETTLEMENT_RECONCILIATION", "../payouts/reconcileCancellationHostSettlement", "reconcileCancellationHostSettlement"],
  ["payment_reconcile", "ENABLE_NEW_FLOW_PAYMENT_RECONCILIATION", "./reconcileNewFlowPayment", "reconcileNewFlowPayment"],
  ["missing_refund_recover", "ENABLE_MISSING_LATE_PAYMENT_REFUND_RECOVERY", "./recoverMissingLatePaymentRefund", "recoverMissingLatePaymentRefund"],
] as const;
let run: typeof import("./runNewFlowFinancialBatch").runNewFlowFinancialBatch;
let calls: { operation: string; id: string }[] = [];
let handler: (operation: string, id: string) => Promise<any>;
let saved: Map<string, string | undefined>;

before(async () => {
  for (const [operation, , module, exported] of entries) {
    mock.module(module, {
      namedExports: { [exported]: async (id: string) => {
        calls.push({ operation, id });
        return handler(operation, id);
      } }
    });
  }
  ({ runNewFlowFinancialBatch: run } = await import("./runNewFlowFinancialBatch"));
});
beforeEach(() => {
  saved = new Map(entries.map(([, flag]) => [flag, process.env[flag]]));
  for (const [, flag] of entries) delete process.env[flag];
  calls = [];
  handler = async () => ({ recorded: false, attempted: false, reserved: false });
});
afterEach(() => {
  for (const [flag, value] of saved) {
    if (value === undefined) delete process.env[flag];
    else process.env[flag] = value;
  }
});
function job(operation: FinancialBatchOperation = "refund_execute") {
  return { operation, id: crypto.randomUUID() as string };
}

for (const [operation, flag] of entries) {
  test("batch gate refuses non-true values: " + operation, async () => {
    for (const value of [undefined, "", "false", "1", "TRUE", " true", "true "]) {
      if (value === undefined) delete process.env[flag];
      else process.env[flag] = value;
      assert.equal((await run([job(operation)]))[0].status, "disabled");
    }
    assert.deepEqual(calls, []);
  });
  test("batch dispatches only independently enabled worker: " + operation, async () => {
    process.env[flag] = "true";
    const jobs = entries.map(([op]) => job(op));
    const results = await run(jobs);
    assert.equal(results.filter(row => row.status === "dispatched").length, 1);
    assert.equal(results.find(row => row.operation === operation)?.status, "dispatched");
    assert.deepEqual(calls, [jobs.find(row => row.operation === operation)]);
  });
}

test("batch validates every job before dispatching any", async () => {
  process.env.ENABLE_NEW_FLOW_REFUND_EXECUTION = "true";
  for (const invalid of [
    { operation: "refund_execute", id: "invalid" },
    { operation: "unknown", id: crypto.randomUUID() },
    null
  ]) {
    await assert.rejects(run([job(), invalid] as any), /Invalid financial batch job/);
  }
  assert.deepEqual(calls, []);
});
test("batch rejects invalid list and oversized batches before dispatch", async () => {
  await assert.rejects(run(null as any), /at most 25/);
  await assert.rejects(run(Array.from({ length: 26 }, () => job())), /at most 25/);
  assert.deepEqual(calls, []);
});
test("batch accepts empty and maximum-sized lists", async () => {
  assert.deepEqual(await run([]), []);
  assert.equal((await run(Array.from({ length: 25 }, () => job()))).length, 25);
  assert.deepEqual(calls, []);
});
test("batch rejects invalid budgets before dispatch", async () => {
  for (const budgetMs of [0, -1, 1.5, NaN, Infinity, 60001]) {
    await assert.rejects(run([job()], { budgetMs }), /Invalid financial batch time budget/);
  }
  assert.deepEqual(calls, []);
});
test("batch rejects duplicate IDs regardless of case", async () => {
  const first = job();
  await assert.rejects(run([first, { ...first, id: first.id.toUpperCase() }]), /Duplicate or conflicting/);
  assert.deepEqual(calls, []);
});
test("batch rejects execution and reconciliation of the same resource", async () => {
  for (const [execute, reconcile] of [
    ["refund_execute", "refund_reconcile"],
    ["transfer_execute", "transfer_reconcile"],
    ["reversal_execute", "reversal_reconcile"],
    ["settlement_execute", "settlement_reconcile"],
    ["payment_reconcile", "missing_refund_recover"]
  ] as const) {
    const id = crypto.randomUUID();
    await assert.rejects(run([{ operation: execute, id }, { operation: reconcile, id }]),
      /Duplicate or conflicting/);
  }
  assert.deepEqual(calls, []);
});
test("batch normalizes IDs without changing caller input", async () => {
  process.env.ENABLE_NEW_FLOW_REFUND_EXECUTION = "true";
  const id = crypto.randomUUID().toUpperCase();
  const input = Object.freeze([Object.freeze({ operation: "refund_execute" as const, id })]);
  assert.equal((await run(input))[0].id, id.toLowerCase());
  assert.equal(input[0].id, id);
  assert.equal(calls[0].id, id.toLowerCase());
});
test("batch rechecks gate between records", async () => {
  process.env.ENABLE_NEW_FLOW_REFUND_EXECUTION = "true";
  handler = async () => {
    delete process.env.ENABLE_NEW_FLOW_REFUND_EXECUTION;
    return { recorded: true };
  };
  const results = await run([job(), job()]);
  assert.deepEqual(results.map(row => row.status), ["dispatched", "disabled"]);
  assert.equal(calls.length, 1);
});
test("batch isolates thrown errors and never retries", async () => {
  process.env.ENABLE_NEW_FLOW_REFUND_EXECUTION = "true";
  const jobs = [job(), job()];
  handler = async (_, id) => {
    if (id === jobs[0].id) throw new Error("secret provider token");
    return { recorded: true };
  };
  const results = await run(jobs);
  assert.deepEqual(results.map(row => row.status), ["error", "dispatched"]);
  assert.deepEqual(calls, jobs);
  assert.equal(JSON.stringify(results).includes("secret"), false);
});
test("batch preserves false outcomes and strips provider details", async () => {
  process.env.ENABLE_NEW_FLOW_REFUND_EXECUTION = "true";
  handler = async () => ({
    recorded: false, attempted: true, reserved: false,
    reason: "internal failure", providerRefundId: "re_private", claim_token: "private"
  });
  const input = job();
  assert.deepEqual(await run([input]), [{
    ...input, status: "dispatched", recorded: false, attempted: true, reserved: false
  }]);
});
test("batch awaits workers sequentially", async () => {
  process.env.ENABLE_NEW_FLOW_REFUND_EXECUTION = "true";
  let active = 0;
  handler = async () => {
    active++;
    assert.equal(active, 1);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return { recorded: true };
  };
  const jobs = [job(), job(), job()];
  await run(jobs);
  assert.deepEqual(calls, jobs);
});
test("batch budget stops later jobs without cancelling an active worker", async () => {
  process.env.ENABLE_NEW_FLOW_REFUND_EXECUTION = "true";
  let now = 0;
  let finished = false;
  const clock = mock.method(performance, "now", () => now);
  try {
    handler = async () => {
      await new Promise(resolve => setImmediate(resolve));
      now = 25;
      finished = true;
      return { recorded: true };
    };
    const results = await run([job(), job()], { budgetMs: 10 });
    assert.equal(finished, true);
    assert.deepEqual(results.map(row => row.status), ["dispatched", "budget_exhausted"]);
    assert.equal(calls.length, 1);
  } finally { clock.mock.restore(); }
});

test("batch rejects sparse arrays before dispatching any job", async () => {
  process.env.ENABLE_NEW_FLOW_REFUND_EXECUTION = "true";
  const jobs = [job()];
  jobs.length = 2;
  await assert.rejects(run(jobs), /Invalid financial batch job/);
  assert.deepEqual(calls, []);
});
