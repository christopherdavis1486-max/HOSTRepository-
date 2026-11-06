import { test, before, mock } from "node:test";
import assert from "node:assert/strict";

let calls: any[], value: any, runnerError: unknown;
let entry: typeof import("./runMonitoredHostTransferBatch");
before(async () => {
  const runner = (kind: string) => async (...args: any[]) => {
    calls.push({kind, args});
    if (runnerError !== undefined) throw runnerError;
    return value;
  };
  mock.module("../payouts/runSelectedHostTransferBatch", {
    namedExports: {runSelectedHostTransferBatch: runner("execute")}
  });
  mock.module("./runNewFlowReconciliationPass", {
    namedExports: {runNewFlowReconciliationPass: runner("reconcile")}
  });
  entry = await import("./runMonitoredHostTransferBatch");
});
function fixture(mode?: "start_failure" | "finish_failure") {
  calls = []; runnerError = undefined;
  value = {status: "disabled", expiredIds: [], results: []};
  const failure = new Error(mode);
  const events: string[] = [];
  let token: string;
  const database = {query: async (sql: string, values: any[]) => {
    if (sql.startsWith("INSERT")) {
      events.push("start:" + values[0]);
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
function invoke(kind: "execute" | "reconcile", database: any, options?: any) {
  return kind === "execute"
    ? entry.runMonitoredHostTransferExecution(database, "worker:test", options)
    : entry.runMonitoredHostTransferReconciliation(database, options);
}
for (const kind of ["execute", "reconcile"] as const) {
  test(kind + ": forwards identity/options and preserves result", async () => {
    const f = fixture();
    value = kind === "execute" ? [] : {status: "completed", expiredIds: ["expired"], results: []};
    const options = {limit: 3, budgetMs: 500, useTransferQueue: true};
    const result = await invoke(kind, f.database, options);
    assert.deepEqual(calls, [{
      kind, args: [kind === "execute" ? "worker:test" : "transfer_reconcile", options]
    }]);
    assert.equal(result.execution.status, "returned");
    if (result.execution.status === "returned") assert.equal(result.execution.value, value);
    assert.equal(result.heartbeat.status, "recorded");
    assert.deepEqual(f.events, ["start:transfer_" + kind, "finish:returned"]);
  });
  test(kind + ": completion-write failure never repeats runner", async () => {
    const f = fixture("finish_failure");
    const result = await invoke(kind, f.database);
    assert.equal(calls.length, 1);
    assert.equal(result.execution.status, "returned");
    if (result.execution.status === "returned") assert.equal(result.execution.value, value);
    assert.equal(result.heartbeat.status, "write_failed");
  });
  test(kind + ": runner failure remains observable once", async () => {
    const f = fixture();
    runnerError = new Error("runner failed");
    const result = await invoke(kind, f.database);
    assert.equal(calls.length, 1);
    assert.equal(result.execution.status, "threw");
    if (result.execution.status === "threw") assert.equal(result.execution.error, runnerError);
    assert.equal(result.heartbeat.status, "recorded");
  });
  test(kind + ": start failure prevents runner invocation", async () => {
    const f = fixture("start_failure");
    await assert.rejects(invoke(kind, f.database), error => error === f.failure);
    assert.equal(calls.length, 0);
  });
}
test("invalid worker identities and options fail before work", async () => {
  const f = fixture();
  for (const worker of ["", "a b", "x".repeat(101), null]) {
    await assert.rejects(entry.runMonitoredHostTransferExecution(f.database, worker as any));
  }
  for (const kind of ["execute", "reconcile"] as const) {
    for (const options of [
      null, [], {limit: 0}, {limit: 26}, {budgetMs: 0},
      {budgetMs: 60001}, {useTransferQueue: "true"}
    ]) await assert.rejects(invoke(kind, f.database, options));
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(f.events, []);
});
test("transfer options are captured before monitoring awaits", async () => {
  const f = fixture();
  const options = {limit: 2, budgetMs: 1000, useTransferQueue: false};
  const pending = invoke("reconcile", f.database, options);
  options.limit = 25; options.useTransferQueue = true;
  await pending;
  assert.deepEqual(calls, [{
    kind: "reconcile",
    args: ["transfer_reconcile", {limit: 2, budgetMs: 1000, useTransferQueue: false}]
  }]);
});
