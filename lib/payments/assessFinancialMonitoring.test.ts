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

test("missing reports remain missing for all ten operations", () => {
  const f = fixture();
  const result = assess(available(f.queue), available([]), f.policy, now);
  assert.equal(result.operations.length, 10);
  assert.ok(result.operations.every(row => row.heartbeat.status === "missing"));
});

for (const outcome of ["started", "returned", "threw"] as const) {
  test("recent reporting preserves callback outcome: " + outcome, () => {
    const f = fixture();
    const result = assess(available(f.queue), available([record(outcome)]), f.policy, now);
    assert.deepEqual(result.operations[0].heartbeat, {
      status: "recent", reportedAt: now.toISOString(), outcome,
      startedAt: now.toISOString(),
      finishedAt: outcome === "started" ? null : now.toISOString()
    });
  });
}

test("stale and future heartbeats remain distinct", () => {
  const f = fixture();
  for (const [at, expected] of [
    ["2026-10-21T19:58:59.999Z", "stale"],
    ["2026-10-21T20:00:00.001Z", "future"]
  ]) {
    const result = assess(available(f.queue), available([record("threw", at)]), f.policy, now);
    assert.equal(result.operations[0].heartbeat.status, expected);
    assert.equal(result.operations[0].heartbeat.outcome, "threw");
  }
});

test("unavailable heartbeat source does not masquerade as missing reports", () => {
  const f = fixture();
  const result = assess(available(f.queue), unavailable, f.policy, now);
  assert.ok(result.operations.every(row => row.heartbeat.status === "unavailable"));
  assert.ok(result.operations.every(row => row.queue.status === "observed"));
});

test("queue collection failure leaves available heartbeat evidence visible", () => {
  const f = fixture();
  const result = assess(unavailable, available([record("threw")]), f.policy, now);
  assert.equal(result.operations[0].queue.status, "unavailable");
  assert.equal(result.operations[0].heartbeat.outcome, "threw");
});

test("stale queue snapshot does not suppress recent heartbeat outcome", () => {
  const f = fixture();
  f.queue.observedAt = "2026-10-21T19:58:00.000Z";
  const result = assess(available(f.queue), available([record()]), f.policy, now);
  assert.deepEqual(result.operations[0].queue,
    {status: "unavailable", reason: "stale_snapshot"});
  assert.equal(result.operations[0].heartbeat.status, "recent");
});

test("paused policy preserves thrown outcome and unknown policy requires configuration", () => {
  const f = fixture();
  f.policy.operations[operations[0]] = {expectedState: "paused" as any, dueReviewAgeMs: 30000};
  delete f.policy.operations[operations[1]];
  const result = assess(available(f.queue), available([record("threw")]), f.policy, now);
  assert.equal(result.operations[0].heartbeat.status, "paused");
  assert.equal(result.operations[0].heartbeat.outcome, "threw");
  assert.equal(result.operations[1].heartbeat.status, "configuration_required");
});

test("recent heartbeat does not suppress overdue selected queue metadata", () => {
  const f = fixture(), row = f.queue.rows[0];
  Object.assign(row, {
    total: "1", due: "1", selectedAwaitingFeedback: "1", selectedDue: "1",
    oldestDueAt: "2026-10-21T19:59:00.000Z",
    oldestReviewedAt: "2026-10-21T19:59:00.000Z"
  });
  const result = assess(available(f.queue), available([record()]), f.policy, now);
  assert.equal(result.operations[0].queue.status, "observed");
  if (result.operations[0].queue.status === "observed") {
    assert.deepEqual(result.operations[0].queue.assessment.observations,
      ["selected_metadata_without_feedback", "due_metadata_requires_review"]);
  }
});

test("invalid policy fails even when both sources are unavailable", () => {
  const f = fixture();
  assert.throws(() => assess(unavailable, unavailable,
    {...f.policy, maxSnapshotAgeMs: 0}, now));
  assert.throws(() => assess(unavailable, unavailable,
    {...f.policy, maxHeartbeatAgeMs: 0}, now));
});

test("malformed and duplicate records fail visibly", () => {
  const f = fixture();
  for (const records of [
    [record(), record()],
    [{...record(), runToken: "invalid"}],
    [{...record(), outcome: "started", finishedAt: now.toISOString()}],
    [{...record(), reportedAt: "invalid"}]
  ]) {
    assert.throws(() => assess(available(f.queue), available(records as any), f.policy, now));
  }
});

test("assessment does not mutate input sources or policy", () => {
  const f = fixture(), records = [record()];
  const before = JSON.stringify({f, records});
  assess(available(f.queue), available(records), f.policy, now);
  assert.equal(JSON.stringify({f, records}), before);
});
