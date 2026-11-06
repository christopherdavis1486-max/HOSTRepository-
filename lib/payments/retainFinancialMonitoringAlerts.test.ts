import { test } from "node:test";
import assert from "node:assert/strict";
import { assessFinancialMonitoring as assess } from "./assessFinancialMonitoring";
import { financialQueueHealthOperations as operations } from "./readFinancialQueueHealth";
import type { FinancialQueueHealth } from "./readFinancialQueueHealth";
import type { FinancialRunnerHeartbeatRecord } from "./financialRunnerHeartbeatStore";

const now = new Date("2026-10-21T20:00:00.000Z");
function fixture() {
  const queue: FinancialQueueHealth = {
    scope: "scheduling_metadata_only", observedAt: now.toISOString(),
    rows: operations.map(operation => ({
      operation, total: "0", due: "0", cooling: "0",
      selectedAwaitingFeedback: "0", selectedDue: "0", unresolved: "0",
      backingOff: "0", resolved: "0", eligible: "0",
      maxReviewFailures: 0, oldestDueAt: null, oldestReviewedAt: null
    }))
  };
  const policy = {
    maxSnapshotAgeMs: 60000, maxHeartbeatAgeMs: 60000,
    operations: Object.fromEntries(operations.map(operation =>
      [operation, {expectedState: "running" as const, dueReviewAgeMs: 30000}]))
  };
  return {queue, policy};
}
function record(outcome: "started" | "returned" | "threw" = "returned",
  at = now.toISOString()): FinancialRunnerHeartbeatRecord {
  return {
    operation: operations[0], runToken: "00000000-0000-4000-8000-000000000001",
    startedAt: at, reportedAt: at,
    finishedAt: outcome === "started" ? null : at, outcome
  };
}
const available = <T>(value: T) => ({status: "available" as const, value});
const unavailable = {status: "unavailable" as const, reason: "collection_failed" as const};



import { planFinancialMonitoringAlerts as plan } from "./planFinancialMonitoringAlerts";

function allReports(): FinancialRunnerHeartbeatRecord[] {
  return operations.map(operation => ({...record(), operation}));
}



import { compareFinancialMonitoringAlerts as compare } from "./compareFinancialMonitoringAlerts";
type AlertInputs = Parameters<typeof plan>;

function inputs(reports: FinancialRunnerHeartbeatRecord[] = allReports()): AlertInputs {
  const f = fixture();
  return [available(f.queue), available(reports), f.policy, new Date(now.getTime())];
}
const missingKey = operations[0] + ":heartbeat_missing";


import { retainFinancialMonitoringAlerts as retain } from "./retainFinancialMonitoringAlerts";

function status(result: ReturnType<typeof retain>, key = missingKey) {
  return result.transitions.find(row => row.finding.key === key)?.status;
}
function absent() {
  const current = inputs();
  current[1] = unavailable;
  return current;
}

test("initial conditions open and repeated conditions continue", () => {
  const first = retain(null, inputs([]));
  assert.equal(first.state.pending.length, 10);
  const second = retain(first.state, inputs([]));
  assert.ok(second.transitions.every(row => row.status === "continuing"));
});

test("missing conditions survive multiple unavailable observations", () => {
  let result = retain(null, inputs([]));
  for (let i = 0; i < 4; i++) {
    result = retain(result.state, absent());
    assert.equal(status(result), "unconfirmed");
    assert.ok(result.state.pending.some(row => row.key === missingKey));
  }
  assert.equal(result.state.pending.length, 11);
});

test("reappearing condition continues after unavailable observations", () => {
  let result = retain(null, inputs([]));
  result = retain(result.state, absent());
  result = retain(result.state, absent());
  result = retain(result.state, inputs([]));
  assert.equal(status(result), "continuing");
  assert.equal(status(result, "monitor:heartbeat_collection_failed"), "cleared");
});

test("later recent evidence clears retained missing conditions once", () => {
  let result = retain(null, inputs([]));
  result = retain(result.state, absent());
  result = retain(result.state, inputs());
  assert.equal(status(result), "cleared");
  assert.equal(result.state.pending.length, 0);
  result = retain(result.state, inputs());
  assert.equal(result.transitions.length, 0);
});

test("a condition opens again after confirmed clearing", () => {
  let result = retain(null, inputs([]));
  result = retain(result.state, inputs());
  result = retain(result.state, inputs([]));
  assert.equal(status(result), "opened");
});

test("pause and unknown policy retain earlier missing conditions", () => {
  let result = retain(null, inputs([]));
  const paused = inputs([]);
  paused[2] = {...paused[2], operations: Object.fromEntries(
    operations.map(operation => [operation, {expectedState: "paused" as const}])
  )};
  result = retain(result.state, paused);
  assert.equal(status(result), "unconfirmed");
  const unknown = inputs([]);
  unknown[2] = {...unknown[2], operations: {}};
  result = retain(result.state, unknown);
  assert.equal(status(result), "unconfirmed");
  result = retain(result.state, inputs());
  assert.equal(status(result), "cleared");
});

test("runner throw survives started reports until a recent return", () => {
  const reports = allReports();
  reports[0] = record("threw");
  let result = retain(null, inputs(reports));
  const key = operations[0] + ":runner_threw";
  reports[0] = record("started");
  for (let i = 0; i < 3; i++) {
    result = retain(result.state, inputs(reports));
    assert.equal(status(result, key), "unconfirmed");
  }
  result = retain(result.state, inputs());
  assert.equal(status(result, key), "cleared");
});

test("retained evidence and state are detached from caller mutations", () => {
  const observation = inputs([]);
  const first = retain(null, observation);
  const before = structuredClone(first.state);
  observation[2].operations = {};
  observation[3]!.setTime(0);
  assert.deepEqual(first.state, before);
  const prior = structuredClone(first.state);
  const second = retain(first.state, absent());
  assert.deepEqual(first.state, prior);
  second.state.pending[0].evidence[2].operations = {};
  assert.deepEqual(first.state, prior);
});

test("older observations are rejected", () => {
  const first = retain(null, inputs([]));
  const older = inputs();
  older[3] = new Date(now.getTime() - 1);
  assert.throws(() => retain(first.state, older), /out of order/);
});

test("duplicate, fabricated and inconsistent retained evidence is rejected", () => {
  const first = retain(null, inputs([]));
  const duplicate = structuredClone(first.state);
  duplicate.pending.push(structuredClone(duplicate.pending[0]));
  assert.throws(() => retain(duplicate, inputs()));
  const fabricated = structuredClone(first.state);
  fabricated.pending[0].key = "invented:condition";
  assert.throws(() => retain(fabricated, inputs()));
  const future = structuredClone(first.state);
  future.assessedAt = new Date(now.getTime() - 1).toISOString();
  assert.throws(() => retain(future, inputs()));
});

test("malformed current observations still fail visibly", () => {
  const observation = inputs();
  observation[1] = available([record(), record()]);
  assert.throws(() => retain(null, observation));
});
