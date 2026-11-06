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


import {previewFinancialMonitoringNotifications as preview}
  from "./previewFinancialMonitoringNotifications";

test("new conditions become preview candidates without delivery", () => {
  const result = preview(null, inputs([]));
  assert.equal(result.scope, "monitoring_notification_preview_only");
  assert.equal(result.deliveryAttempted, false);
  assert.equal(result.candidates.length, 10);
  assert.ok(result.candidates.every(row => row.status === "opened"));
  assert.equal(result.continuing.length, 0);
  assert.equal(result.unconfirmed.length, 0);
});

test("continuing conditions stay visible without new candidates", () => {
  const first = preview(null, inputs([]));
  const next = preview(first.state, inputs([]));
  assert.equal(next.candidates.length, 0);
  assert.equal(next.continuing.length, 10);
  assert.equal(next.unconfirmed.length, 0);
});

test("unavailable evidence retains uncertainty alongside the source finding", () => {
  const first = preview(null, inputs([]));
  const next = preview(first.state, absent());
  assert.equal(next.unconfirmed.length, 10);
  assert.ok(next.unconfirmed.every(row => row.status === "unconfirmed"));
  assert.equal(next.candidates.length, 1);
  assert.equal(next.candidates[0].status, "opened");
  assert.equal(next.candidates[0].finding.key,
    "monitor:heartbeat_collection_failed");
  assert.equal(next.state.pending.length, 11);
});

test("confirmed clearing is scoped to monitoring and appears once in a chain", () => {
  const first = preview(null, inputs([]));
  const held = preview(first.state, absent());
  const cleared = preview(held.state, inputs());
  assert.equal(cleared.candidates.length, 11);
  assert.ok(cleared.candidates.every(row => row.status === "cleared"));
  assert.equal(cleared.clearingMeaning, "named_monitoring_condition_only");
  assert.equal(cleared.state.pending.length, 0);
  assert.equal(preview(cleared.state, inputs()).candidates.length, 0);
});

test("pause does not turn missing evidence into a clearing candidate", () => {
  const first = preview(null, inputs([]));
  const paused = inputs([]);
  paused[2] = {...paused[2], operations: Object.fromEntries(
    operations.map(operation => [operation, {expectedState: "paused" as const}])
  )};
  const next = preview(first.state, paused);
  assert.equal(next.candidates.length, 0);
  assert.equal(next.unconfirmed.length, 10);
});

test("preview leaves inputs unchanged and returns detached state and findings", () => {
  const observation = inputs([]);
  const previous = preview(null, observation).state;
  const beforeObservation = structuredClone(observation);
  const beforePrevious = structuredClone(previous);
  const next = preview(previous, observation);
  assert.deepEqual(observation, beforeObservation);
  assert.deepEqual(previous, beforePrevious);
  next.continuing[0].finding.code = "changed";
  next.state.pending[0].evidence[2].operations = {};
  assert.deepEqual(observation, beforeObservation);
  assert.deepEqual(previous, beforePrevious);
});

test("invalid retained history fails rather than producing a preview", () => {
  const previous = preview(null, inputs([])).state;
  previous.pending[0].key = "invented:condition";
  assert.throws(() => preview(previous, inputs()));
});
