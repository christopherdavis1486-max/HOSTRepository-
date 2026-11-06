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


import fs from "node:fs";
const rehearsalPolicy = JSON.parse(fs.readFileSync(
  "docs/financial-monitoring-local-rehearsal-policy-2026-10-22.json", "utf8"
));
function rehearsal(reports = allReports(), at = new Date(now.getTime())) {
  const f = fixture();
  return plan(available(f.queue), available(reports), rehearsalPolicy, at);
}

test("local rehearsal policy covers all ten synthetic running operations", () => {
  assert.deepEqual(Object.keys(rehearsalPolicy.operations).sort(),
    [...operations].sort());
  const result = rehearsal();
  assert.equal(result.findings.length, 0);
});

test("heartbeat freshness includes exactly sixty seconds", () => {
  const result = rehearsal(allReports(), new Date(now.getTime() + 60000));
  assert.ok(result.assessment.operations.every(
    row => row.heartbeat.status === "recent"));
});

test("heartbeat becomes stale immediately beyond sixty seconds", () => {
  const result = rehearsal(allReports(), new Date(now.getTime() + 60001));
  assert.equal(result.findings.filter(row =>
    row.code === "heartbeat_stale").length, 10);
});

test("snapshot freshness includes thirty seconds and rejects older snapshots", () => {
  const boundary = rehearsal(allReports(), new Date(now.getTime() + 30000));
  assert.equal(boundary.assessment.queue.status, "available");
  if (boundary.assessment.queue.status === "available") {
    assert.equal(boundary.assessment.queue.assessment.status, "observed");
  }
  const older = rehearsal(allReports(), new Date(now.getTime() + 30001));
  assert.ok(older.findings.some(row => row.code === "queue_stale_snapshot"));
});

test("running rehearsal operations without reports remain visibly missing", () => {
  const result = rehearsal([]);
  assert.equal(result.findings.filter(row =>
    row.code === "heartbeat_missing").length, 10);
});

test("undecided worksheet is rejected as executable policy", () => {
  const draft = JSON.parse(fs.readFileSync(
    "docs/financial-monitoring-policy-draft-2026-10-22.json", "utf8"
  ));
  const f = fixture();
  assert.throws(() => plan(
    available(f.queue), available(allReports()), draft, now
  ));
});
