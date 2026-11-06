import { test, before, mock } from "node:test";
import assert from "node:assert/strict";

let calls: any[];
let value: any;
let runnerError: unknown;
let run: typeof import("./runMonitoredNewFlowRefundBatch").runMonitoredNewFlowRefundBatch;

before(async () => {
  mock.module("./runSelectedNewFlowRefundBatch", {
    namedExports: {
      runSelectedNewFlowRefundBatch: async (...args: any[]) => {
        calls.push(args);
        if (runnerError !== undefined) throw runnerError;
        return value;
      }
    }
  });
  ({runMonitoredNewFlowRefundBatch: run} =
    await import("./runMonitoredNewFlowRefundBatch"));
});

function fixture(mode?: "start_failure" | "finish_failure") {
  calls = [];
  value = [];
  runnerError = undefined;
  const events: string[] = [];
  let token: string;
  const failure = new Error(mode);
  const database = {query: async (sql: string, values: any[]) => {
    if (sql.startsWith("INSERT")) {
      events.push("start");
      if (mode === "start_failure") throw failure;
      token = values[1];
      return {rows: [{run_token: token}]};
    }
    events.push("finish:" + values[2]);
    assert.equal(values[1], token);
    if (mode === "finish_failure") throw failure;
    return {rows: [{run_token: token}]};
  }} as any;
  return {database, events, failure};
}

for (const operation of ["refund_execute", "refund_reconcile"] as const) {
  test(operation + ": forwards options and preserves result once", async () => {
    const f = fixture();
    value = [{operation, id: "fixture", status: "disabled"}];
    const result = await run(f.database, operation, {
      limit: 3, budgetMs: 500, useRefundQueue: true
    });
    assert.deepEqual(calls, [[operation, {
      limit: 3, budgetMs: 500, useRefundQueue: true
    }]]);
    assert.equal(result.execution.status, "returned");
    if (result.execution.status === "returned") assert.equal(result.execution.value, value);
    assert.equal(result.heartbeat.status, "recorded");
    assert.deepEqual(f.events, ["start", "finish:returned"]);
  });

  test(operation + ": heartbeat feedback failure never repeats runner", async () => {
    const f = fixture("finish_failure");
    value = [{operation, status: "dispatched", recorded: true}];
    const result = await run(f.database, operation);
    assert.equal(calls.length, 1);
    assert.equal(result.execution.status, "returned");
    if (result.execution.status === "returned") assert.equal(result.execution.value, value);
    assert.equal(result.heartbeat.status, "write_failed");
  });

  test(operation + ": runner failure is retained without retry", async () => {
    const f = fixture();
    runnerError = new Error("Injected runner failure");
    const result = await run(f.database, operation);
    assert.equal(calls.length, 1);
    assert.equal(result.execution.status, "threw");
    if (result.execution.status === "threw") assert.equal(result.execution.error, runnerError);
    assert.deepEqual(f.events, ["start", "finish:threw"]);
  });
}

test("start-write failure prevents refund runner invocation", async () => {
  const f = fixture("start_failure");
  await assert.rejects(run(f.database, "refund_execute"), error => error === f.failure);
  assert.equal(calls.length, 0);
  assert.deepEqual(f.events, ["start"]);
});

test("invalid operation/options fail before monitoring and runner work", async () => {
  const f = fixture();
  await assert.rejects(run(f.database, "unknown" as any));
  for (const options of [
    null, [], {limit: 0}, {limit: 26}, {budgetMs: 0},
    {budgetMs: 60001}, {useRefundQueue: "true"}
  ]) {
    await assert.rejects(run(f.database, "refund_execute", options as any));
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(f.events, []);
});

test("runner options are captured before awaiting heartbeat start", async () => {
  const f = fixture();
  const options = {limit: 2, budgetMs: 1000, useRefundQueue: false};
  const pending = run(f.database, "refund_execute", options);
  options.limit = 25;
  options.useRefundQueue = true;
  await pending;
  assert.deepEqual(calls, [["refund_execute", {
    limit: 2, budgetMs: 1000, useRefundQueue: false
  }]]);
});
