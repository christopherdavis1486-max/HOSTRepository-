import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithFinancialRunnerHeartbeat as wrap } from "./runWithFinancialRunnerHeartbeat";

const operation = "refund_execute";
function fixture(options: {
  startError?: Error;
  finishError?: Error;
  superseded?: boolean;
} = {}) {
  const events: string[] = [];
  let token: string;
  const database = {query: async (sql: string, values: any[]) => {
    if (sql.startsWith("INSERT")) {
      events.push("start");
      if (options.startError) throw options.startError;
      token = values[1];
      return {rows: [{run_token: token}]};
    }
    events.push("finish:" + values[2]);
    assert.equal(values[0], operation);
    assert.equal(values[1], token);
    if (options.finishError) throw options.finishError;
    return {rows: options.superseded ? [] : [{run_token: token}]};
  }} as any;
  return {events, database};
}

test("records start, invokes once and preserves returned value identity", async () => {
  const f = fixture(), value = {status: "disabled", results: []};
  let calls = 0;
  const result = await wrap(f.database, operation, async () => {
    calls++; f.events.push("run"); return value;
  });
  assert.equal(calls, 1);
  assert.deepEqual(f.events, ["start", "run", "finish:returned"]);
  assert.equal(result.execution.status, "returned");
  if (result.execution.status === "returned") assert.equal(result.execution.value, value);
  assert.equal(result.heartbeat.status, "recorded");
});

test("start failure prevents callback and completion writes", async () => {
  const failure = new Error("start failed"), f = fixture({startError: failure});
  let calls = 0;
  await assert.rejects(wrap(f.database, operation, async () => {calls++;}),
    error => error === failure);
  assert.equal(calls, 0);
  assert.deepEqual(f.events, ["start"]);
});

test("callback rejection is preserved and reported without retry", async () => {
  const failure = new Error("runner failed"), f = fixture();
  let calls = 0;
  const result = await wrap(f.database, operation, async () => {
    calls++; throw failure;
  });
  assert.equal(calls, 1);
  assert.equal(result.execution.status, "threw");
  if (result.execution.status === "threw") assert.equal(result.execution.error, failure);
  assert.equal(result.heartbeat.status, "recorded");
  assert.deepEqual(f.events, ["start", "finish:threw"]);
});

test("completion write failure preserves successful callback result", async () => {
  const failure = new Error("feedback failed"), f = fixture({finishError: failure});
  const value = {committed: true};
  let calls = 0;
  const result = await wrap(f.database, operation, async () => {calls++; return value;});
  assert.equal(calls, 1);
  assert.equal(result.execution.status, "returned");
  if (result.execution.status === "returned") assert.equal(result.execution.value, value);
  assert.equal(result.heartbeat.status, "write_failed");
  if (result.heartbeat.status === "write_failed") assert.equal(result.heartbeat.error, failure);
  assert.deepEqual(f.events, ["start", "finish:returned"]);
});

test("callback and completion failures remain separately observable", async () => {
  const runError = new Error("runner"), writeError = new Error("monitor");
  const f = fixture({finishError: writeError});
  const result = await wrap(f.database, operation, async () => {throw runError;});
  assert.equal(result.execution.status, "threw");
  if (result.execution.status === "threw") assert.equal(result.execution.error, runError);
  assert.equal(result.heartbeat.status, "write_failed");
  if (result.heartbeat.status === "write_failed") assert.equal(result.heartbeat.error, writeError);
});

test("superseded token preserves callback result without another invocation", async () => {
  const f = fixture({superseded: true});
  let calls = 0;
  const result = await wrap(f.database, operation, async () => {calls++; return 42;});
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    execution: {status: "returned", value: 42},
    heartbeat: {status: "superseded"}
  });
});

test("invalid callback or operation fails before database access", async () => {
  const f = fixture();
  await assert.rejects(wrap(f.database, operation, null as any));
  await assert.rejects(wrap(f.database, "unknown", async () => 1));
  assert.deepEqual(f.events, []);
});

test("synchronous callback throw is captured exactly once", async () => {
  const f = fixture();
  let calls = 0;
  const result = await wrap(f.database, operation, (() => {
    calls++; throw "original rejection";
  }) as any);
  assert.equal(calls, 1);
  assert.deepEqual(result.execution, {status: "threw", error: "original rejection"});
  assert.equal(result.heartbeat.status, "recorded");
});
