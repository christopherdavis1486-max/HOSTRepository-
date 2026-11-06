import { test, before, mock } from "node:test";
import assert from "node:assert/strict";

let calls: any[], value: any, runnerError: unknown;
let run: typeof import("./runMonitoredCancellationFinancialBatch").runMonitoredCancellationFinancialBatch;
before(async () => {
  mock.module("./runSelectedCancellationFinancialBatch", {
    namedExports: {
      runSelectedCancellationFinancialBatch: async (...args: any[]) => {
        calls.push(args);
        if (runnerError !== undefined) throw runnerError;
        return value;
      }
    }
  });
  ({runMonitoredCancellationFinancialBatch: run} =
    await import("./runMonitoredCancellationFinancialBatch"));
});
function fixture(mode?: "start_failure" | "finish_failure") {
  calls = []; runnerError = undefined;
  value = {status: "disabled", expiredIds: [], results: []};
  const events: string[] = [];
  const failure = new Error(mode);
  let token: string;
  const database = {query: async (sql: string, values: any[]) => {
    if (sql.startsWith("INSERT")) {
      events.push("start");
      if (mode === "start_failure") throw failure;
      token = values[1];
    } else {
      events.push("finish:" + values[2]);
      assert.equal(values[1], token);
      if (mode === "finish_failure") throw failure;
    }
    return {rows: [{run_token: token}]};
  }} as any;
  return {database, events, failure};
}
const operations = [
  "reversal_execute", "reversal_reconcile",
  "settlement_execute", "settlement_reconcile"
] as const;
for (const operation of operations) {
  test(operation + ": forwards matching queue options and preserves result", async () => {
    const f = fixture();
    const options = {
      limit: 3, budgetMs: 500,
      useSettlementQueue: operation.startsWith("settlement_"),
      useReversalQueue: operation.startsWith("reversal_")
    };
    const result = await run(f.database, operation, options);
    assert.deepEqual(calls, [[operation, options]]);
    assert.equal(result.execution.status, "returned");
    if (result.execution.status === "returned") assert.equal(result.execution.value, value);
    assert.equal(result.heartbeat.status, "recorded");
    assert.deepEqual(f.events, ["start", "finish:returned"]);
  });
  test(operation + ": feedback failure never repeats runner", async () => {
    const f = fixture("finish_failure");
    const result = await run(f.database, operation);
    assert.equal(calls.length, 1);
    assert.equal(result.execution.status, "returned");
    if (result.execution.status === "returned") assert.equal(result.execution.value, value);
    assert.equal(result.heartbeat.status, "write_failed");
  });
  test(operation + ": runner failure is retained once", async () => {
    const f = fixture();
    runnerError = new Error("runner failure");
    const result = await run(f.database, operation);
    assert.equal(calls.length, 1);
    assert.equal(result.execution.status, "threw");
    if (result.execution.status === "threw") assert.equal(result.execution.error, runnerError);
    assert.deepEqual(f.events, ["start", "finish:threw"]);
  });
}
test("start failure prevents cancellation runner invocation", async () => {
  const f = fixture("start_failure");
  await assert.rejects(run(f.database, "reversal_execute"), e => e === f.failure);
  assert.equal(calls.length, 0);
  assert.deepEqual(f.events, ["start"]);
});
test("invalid arguments and mismatched queue options fail before work", async () => {
  const f = fixture();
  await assert.rejects(run(f.database, "unknown" as any));
  for (const options of [
    null, [], {limit: 0}, {limit: 26}, {budgetMs: 0}, {budgetMs: 60001},
    {useReversalQueue: "true"}, {useSettlementQueue: "true"},
    {useSettlementQueue: true}
  ]) await assert.rejects(run(f.database, "reversal_execute", options as any));
  await assert.rejects(run(f.database, "settlement_execute", {useReversalQueue: true}));
  assert.deepEqual(f.events, []);
  assert.equal(calls.length, 0);
});
test("options are captured before monitoring awaits", async () => {
  const f = fixture();
  const options = {limit: 2, budgetMs: 1000, useReversalQueue: true};
  const pending = run(f.database, "reversal_execute", options);
  options.limit = 25; options.useReversalQueue = false;
  await pending;
  assert.deepEqual(calls, [["reversal_execute", {
    limit: 2, budgetMs: 1000, useReversalQueue: true, useSettlementQueue: undefined
  }]]);
});
