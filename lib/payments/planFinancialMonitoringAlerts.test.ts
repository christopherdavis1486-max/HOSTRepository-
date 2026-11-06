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

test("recent returned reports and empty queues produce no findings", () => {
  const f = fixture();
  const result = plan(available(f.queue), available(allReports()), f.policy, now);
  assert.equal(result.scope, "monitoring_alert_plan_only");
  assert.deepEqual(result.findings, []);
});

test("missing running reports produce one stable finding per operation", () => {
  const f = fixture();
  const result = plan(available(f.queue), available([]), f.policy, now);
  assert.equal(result.findings.length, 10);
  assert.ok(result.findings.every(row =>
    row.code === "heartbeat_missing" && row.severity === "warning"));
  assert.equal(new Set(result.findings.map(row => row.key)).size, 10);
});

test("unknown policy produces one configuration finding per operation", () => {
  const f = fixture();
  const result = plan(available(f.queue), available([]),
    {...f.policy, operations: {}}, now);
  assert.equal(result.findings.length, 10);
  assert.ok(result.findings.every(row => row.code === "configuration_required"));
});

test("unavailable sources remain source-level findings", () => {
  const f = fixture();
  const result = plan(unavailable, unavailable, f.policy, now);
  assert.deepEqual(result.findings.map(row => row.key), [
    "monitor:heartbeat_collection_failed", "monitor:queue_collection_failed"
  ]);
});

test("stale queue snapshot produces one finding while heartbeats remain assessed", () => {
  const f = fixture();
  f.queue.observedAt = "2026-10-21T19:58:00.000Z";
  const result = plan(available(f.queue), available(allReports()), f.policy, now);
  assert.deepEqual(result.findings.map(row => row.key), ["monitor:queue_stale_snapshot"]);
});

test("explicit pause suppresses missing freshness findings", () => {
  const f = fixture();
  const policy = {
    ...f.policy,
    operations: Object.fromEntries(operations.map(operation =>
      [operation, {expectedState: "paused" as const}]))
  };
  const result = plan(available(f.queue), available([]), policy, now);
  assert.deepEqual(result.findings, []);
});

test("paused operation retains a recorded thrown outcome", () => {
  const f = fixture();
  const policy = {
    ...f.policy,
    operations: Object.fromEntries(operations.map(operation =>
      [operation, {expectedState: "paused" as const}]))
  };
  const result = plan(available(f.queue), available([record("threw")]), policy, now);
  assert.deepEqual(result.findings.map(row => row.key),
    [operations[0] + ":runner_threw"]);
});

test("recent heartbeat does not suppress overdue selected queue findings", () => {
  const f = fixture();
  Object.assign(f.queue.rows[0], {
    total: "1", due: "1", selectedAwaitingFeedback: "1", selectedDue: "1",
    oldestDueAt: "2026-10-21T19:59:00.000Z",
    oldestReviewedAt: "2026-10-21T19:59:00.000Z"
  });
  const result = plan(available(f.queue), available(allReports()), f.policy, now);
  assert.deepEqual(result.findings.map(row => row.code).sort(), [
    "due_metadata_requires_review", "selected_metadata_without_feedback"
  ]);
});

test("backoff is informational and unresolved metadata remains visible", () => {
  const f = fixture();
  Object.assign(f.queue.rows[0], {
    total: "1", cooling: "1", unresolved: "1", backingOff: "1",
    maxReviewFailures: 1, oldestReviewedAt: "2026-10-21T19:59:00.000Z"
  });
  const result = plan(available(f.queue), available(allReports()), f.policy, now);
  assert.equal(result.findings.find(row => row.code === "backoff_in_progress")!.severity,
    "information");
  assert.equal(result.findings.find(row =>
    row.code === "unresolved_scheduling_metadata")!.severity, "warning");
});

test("stale and future heartbeat findings remain distinct", () => {
  const f = fixture();
  for (const [at, code] of [
    ["2026-10-21T19:58:00.000Z", "heartbeat_stale"],
    ["2026-10-21T20:00:00.001Z", "heartbeat_future"]
  ]) {
    const reports = allReports();
    reports[0] = record("returned", at);
    const result = plan(available(f.queue), available(reports), f.policy, now);
    assert.deepEqual(result.findings.map(row => row.code), [code]);
  }
});

test("finding keys remain stable across assessment times", () => {
  const f = fixture();
  const first = plan(available(f.queue), available([]), f.policy, now);
  const second = plan(available(f.queue), available([]), f.policy,
    new Date(now.getTime() + 1));
  assert.deepEqual(first.findings, second.findings);
});

test("invalid source data fails visibly and inputs remain unchanged", () => {
  const f = fixture(), reports = allReports();
  const before = JSON.stringify({f, reports});
  plan(available(f.queue), available(reports), f.policy, now);
  assert.equal(JSON.stringify({f, reports}), before);
  assert.throws(() => plan(available(f.queue),
    available([record(), record()]), f.policy, now));
});
