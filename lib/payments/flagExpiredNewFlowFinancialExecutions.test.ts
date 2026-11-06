import { test, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { FinancialExpiryOperation } from "./flagExpiredNewFlowFinancialExecutions";

const entries = [
  ["refund_reconcile", "ENABLE_NEW_FLOW_REFUND_RECONCILIATION"],
  ["transfer_reconcile", "ENABLE_HOST_TRANSFER_RECONCILIATION"],
  ["reversal_reconcile", "ENABLE_TRANSFER_REVERSAL_RECONCILIATION"],
  ["settlement_reconcile", "ENABLE_CANCELLATION_HOST_SETTLEMENT_RECONCILIATION"],
] as const;

let run: typeof import("./flagExpiredNewFlowFinancialExecutions").flagExpiredNewFlowFinancialExecutions;
let calls: { operation: FinancialExpiryOperation; limit: number }[];
let saved: Map<string, string | undefined>;
let outcome: string[];
let handler: () => Promise<string[]>;

function helper(operation: FinancialExpiryOperation) {
  return async (limit: number) => {
    calls.push({ operation, limit });
    return handler();
  };
}
before(async () => {
  mock.module("./newFlowRefund", {
    namedExports: {
      flagExpiredNewFlowRefundsForReconciliation: helper("refund_reconcile"),
    },
  });
  mock.module("../payouts/flagExpiredTransferExecutions", {
    namedExports: {
      flagExpiredHostTransfers: helper("transfer_reconcile"),
      flagExpiredTransferReversals: helper("reversal_reconcile"),
    },
  });
  mock.module("../payouts/reconcileCancellationHostSettlement", {
    namedExports: {
      flagExpiredCancellationHostSettlements: helper("settlement_reconcile"),
    },
  });
  ({ flagExpiredNewFlowFinancialExecutions: run } =
    await import("./flagExpiredNewFlowFinancialExecutions"));
});
beforeEach(() => {
  saved = new Map(entries.map(([, flag]) => [flag, process.env[flag]]));
  for (const [, flag] of entries) delete process.env[flag];
  calls = [];
  outcome = [crypto.randomUUID()];
  handler = async () => outcome;
});
afterEach(() => {
  for (const [flag, value] of saved) {
    if (value === undefined) delete process.env[flag];
    else process.env[flag] = value;
  }
});

test("financial expiry validates operation and limit before invoking helpers", async () => {
  for (const operation of ["unknown", "__proto__", "constructor", null, undefined]) {
    await assert.rejects(run(operation as any), /Invalid financial expiry operation/);
  }
  for (const limit of [0, -1, 1.5, NaN, Infinity, 26, null, "1"]) {
    await assert.rejects(run("refund_reconcile", limit as any), /Invalid financial expiry limit/);
  }
  assert.deepEqual(calls, []);
});

for (const [operation, flag] of entries) {
  test("financial expiry refuses non-true gate values: " + operation, async () => {
    for (const value of [undefined, "", "false", "1", "TRUE", " true", "true "]) {
      if (value === undefined) delete process.env[flag];
      else process.env[flag] = value;
      assert.deepEqual(await run(operation), []);
    }
    assert.deepEqual(calls, []);
  });

  test("financial expiry invokes only its independently enabled helper: " + operation, async () => {
    process.env[flag] = "true";
    for (const [candidate] of entries) {
      assert.deepEqual(await run(candidate, 3), candidate === operation ? outcome : []);
    }
    assert.deepEqual(calls, [{ operation, limit: 3 }]);
  });

  test("financial expiry passes default and maximum limits: " + operation, async () => {
    process.env[flag] = "true";
    assert.deepEqual(await run(operation), outcome);
    assert.deepEqual(await run(operation, 25), outcome);
    assert.deepEqual(calls, [
      { operation, limit: 25 }, { operation, limit: 25 },
    ]);
  });

  test("financial expiry propagates helper failure without retry: " + operation, async () => {
    process.env[flag] = "true";
    handler = async () => { throw new Error("Injected expiry failure"); };
    await assert.rejects(run(operation), /Injected expiry failure/);
    assert.deepEqual(calls, [{ operation, limit: 25 }]);
  });

  test("financial expiry preserves an empty result: " + operation, async () => {
    process.env[flag] = "true";
    outcome = [];
    assert.deepEqual(await run(operation, 1), []);
    assert.deepEqual(calls, [{ operation, limit: 1 }]);
  });
}
