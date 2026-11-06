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
  return [available(f.queue), available(reports), f.policy, now];
}
function statusFor(result: ReturnType<typeof compare>, key: string) {
  return result.transitions.find(row => row.finding.key === key)?.status;
}
const missingKey = operations[0] + ":heartbeat_missing";

test("first observation opens findings", () => {
  const result = compare(null, inputs([]));
  assert.equal(result.transitions.length, 10);
  assert.ok(result.transitions.every(row => row.status === "opened"));
});

test("identical findings continue without reopening", () => {
  const result = compare(inputs([]), inputs([]));
  assert.equal(result.transitions.length, 10);
  assert.ok(result.transitions.every(row => row.status === "continuing"));
});

test("recent reports confirm missing-heartbeat condition cleared", () => {
  const result = compare(inputs([]), inputs());
  assert.equal(statusFor(result, missingKey), "cleared");
});

test("unavailable heartbeat collection does not confirm recovery", () => {
  const current = inputs();
  current[1] = unavailable;
  const result = compare(inputs([]), current);
  assert.equal(statusFor(result, missingKey), "unconfirmed");
  assert.equal(statusFor(result, "monitor:heartbeat_collection_failed"), "opened");
});

test("pause does not confirm a previously missing heartbeat recovered", () => {
  const current = inputs([]);
  current[2] = {
    ...current[2],
    operations: Object.fromEntries(operations.map(operation =>
      [operation, {expectedState: "paused" as const}]))
  };
  assert.equal(statusFor(compare(inputs([]), current), missingKey), "unconfirmed");
});

test("unknown policy does not confirm heartbeat recovery", () => {
  const current = inputs([]);
  current[2] = {...current[2], operations: {}};
  const result = compare(inputs([]), current);
  assert.equal(statusFor(result, missingKey), "unconfirmed");
  assert.equal(statusFor(result, operations[0] + ":configuration_required"), "opened");
});

test("stale report does not clear a previously missing-heartbeat condition", () => {
  const reports = allReports();
  reports[0] = record("returned", "2026-10-21T19:58:00.000Z");
  const result = compare(inputs([]), inputs(reports));
  assert.equal(statusFor(result, missingKey), "unconfirmed");
  assert.equal(statusFor(result, operations[0] + ":heartbeat_stale"), "opened");
});

test("new recent returned outcome clears recorded runner throw", () => {
  const reports = allReports();
  reports[0] = record("threw");
  const result = compare(inputs(reports), inputs());
  assert.equal(statusFor(result, operations[0] + ":runner_threw"), "cleared");
});

test("new started outcome does not establish completion after runner throw", () => {
  const before = allReports(), after = allReports();
  before[0] = record("threw");
  after[0] = record("started");
  const result = compare(inputs(before), inputs(after));
  assert.equal(statusFor(result, operations[0] + ":runner_threw"), "unconfirmed");
});

test("available source clears collection-failure condition while missing reports remain", () => {
  const previous = inputs();
  previous[1] = unavailable;
  const result = compare(previous, inputs([]));
  assert.equal(statusFor(result, "monitor:heartbeat_collection_failed"), "cleared");
  assert.equal(statusFor(result, missingKey), "opened");
});

test("explicit policy clears configuration condition independently of heartbeat availability", () => {
  const previous = inputs();
  previous[2] = {...previous[2], operations: {}};
  const current = inputs();
  current[1] = unavailable;
  const result = compare(previous, current);
  assert.equal(statusFor(result, operations[0] + ":configuration_required"), "cleared");
  assert.equal(statusFor(result, "monitor:heartbeat_collection_failed"), "opened");
});

test("older observation is rejected and input observations are not mutated", () => {
  const previous = inputs(), current = inputs();
  const before = JSON.stringify({previous, current});
  compare(previous, current);
  assert.equal(JSON.stringify({previous, current}), before);
  current[3] = new Date(now.getTime() - 1);
  assert.throws(() => compare(previous, current), /out of order/);
});
