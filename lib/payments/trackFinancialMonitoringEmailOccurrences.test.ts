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


import {trackFinancialMonitoringEmailOccurrences as track}
  from "./trackFinancialMonitoringEmailOccurrences";

const binding = {
  environment: "local", database: "host_test", schema: "fixture"
};
const chainId = "a".repeat(64);
const head = (value: number) => value.toString(16).padStart(64, "0");

test("continuing and unavailable observations retain the opening occurrence", () => {
  const first = track(null, inputs([]), binding, chainId, head(1));
  const continued = track(first.state, inputs([]), binding, chainId, head(2));
  const held = track(continued.state, absent(), binding, chainId, head(3));
  const original = first.state.active.find(row => row.key === missingKey)!;
  assert.deepEqual(continued.state.active.find(row => row.key === missingKey),
    original);
  assert.deepEqual(held.state.active.find(row => row.key === missingKey),
    original);
  assert.equal(held.transitions.find(row =>
    row.finding.key === missingKey)!.status, "unconfirmed");
  assert.equal(held.state.active.length, 11);
});

test("validated clearing closes an occurrence and recurrence gets a new id", () => {
  const first = track(null, inputs([]), binding, chainId, head(1));
  const cleared = track(first.state, inputs(), binding, chainId, head(2));
  assert.equal(cleared.state.active.length, 0);
  assert.ok(cleared.transitions.every(row => row.status === "cleared"));
  const oldId = first.state.active.find(row => row.key === missingKey)!.id;
  assert.equal(cleared.transitions.find(row =>
    row.finding.key === missingKey)!.occurrence.id, oldId);
  const reopened = track(cleared.state, inputs([]), binding, chainId, head(3));
  assert.notEqual(reopened.state.active.find(row =>
    row.key === missingKey)!.id, oldId);
});

test("wrong context, duplicate record and fabricated occurrence state fail", () => {
  const first = track(null, inputs([]), binding, chainId, head(1));
  assert.throws(() => track(first.state, inputs(), binding, chainId, head(1)));
  assert.throws(() => track(first.state, inputs(),
    {...binding, schema: "other"}, chainId, head(2)));
  assert.throws(() => track(first.state, inputs(),
    binding, "b".repeat(64), head(2)));
  const fabricated = structuredClone(first.state);
  fabricated.active[0].id = "f".repeat(64);
  assert.throws(() => track(fabricated, inputs(), binding, chainId, head(2)));
  const missing = structuredClone(first.state);
  missing.active.pop();
  assert.throws(() => track(missing, inputs(), binding, chainId, head(2)));
});

test("tracking preserves inputs and returns detached occurrence state", () => {
  const observation = inputs([]);
  const first = track(null, observation, binding, chainId, head(1));
  const before = structuredClone(first.state);
  const observationBefore = structuredClone(observation);
  const next = track(first.state, observation, binding, chainId, head(2));
  next.state.active[0].key = "changed";
  next.state.history.pending[0].evidence[2].operations = {};
  next.transitions[0].occurrence.key = "changed";
  assert.deepEqual(first.state, before);
  assert.deepEqual(observation, observationBefore);
});


test("identity property order does not break lifecycle continuation", () => {
  const first = track(null, inputs([]), binding, chainId, head(1));
  first.state.identity = {
    schema: binding.schema,
    database: binding.database,
    environment: binding.environment
  };
  const continued = track(first.state, inputs([]), binding, chainId, head(2));
  assert.equal(continued.state.active.length, 10);
  assert.ok(continued.transitions.every(row => row.status === "continuing"));
  assert.deepEqual(
    continued.state.active.map(row => row.id),
    first.state.active.map(row => row.id)
  );

  const invalid = structuredClone(first.state);
  (invalid.identity as any).extra = "unexpected";
  assert.throws(() => track(invalid, inputs(), binding, chainId, head(2)));
});
