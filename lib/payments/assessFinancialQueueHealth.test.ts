import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessFinancialQueueHealth,
  type QueueMonitoringPolicy,
} from "./assessFinancialQueueHealth";
import {
  financialQueueHealthOperations,
  type FinancialQueueHealth,
} from "./readFinancialQueueHealth";

const observedAt = "2026-10-21T12:00:00.000Z";
const now = new Date("2026-10-21T12:00:30.000Z");
const operation = "refund_execute";

function snapshot(): FinancialQueueHealth {
  return {
    observedAt, scope:"scheduling_metadata_only",
    rows:[...financialQueueHealthOperations].sort().map(operation => ({
      operation, total:"0", due:"0", cooling:"0",
      selectedAwaitingFeedback:"0", selectedDue:"0",
      unresolved:"0", backingOff:"0", resolved:"0", eligible:"0",
      maxReviewFailures:0, oldestDueAt:null, oldestReviewedAt:null,
    })),
  };
}
function policy(
  expectedState: "running" | "paused" | "unknown" = "running",
  dueReviewAgeMs: number | undefined = 120000
): QueueMonitoringPolicy {
  return {maxSnapshotAgeMs:60000, operations:{
    [operation]:{expectedState, dueReviewAgeMs},
  }};
}
function selected(report: FinancialQueueHealth, name = operation) {
  const row = report.rows.find(row => row.operation === name)!;
  Object.assign(row, {
    total:"1", due:"1", selectedAwaitingFeedback:"1", selectedDue:"1",
    oldestDueAt:"2026-10-21T11:58:00.000Z",
    oldestReviewedAt:"2026-10-21T11:57:30.000Z",
  });
  return row;
}
function assessed(report: FinancialQueueHealth, rules = policy()) {
  return assessFinancialQueueHealth(report, rules, now).operations.find(
    row => row.operation === operation
  )!;
}

test("missing runner context requires configuration and never reports healthy", () => {
  const result = assessFinancialQueueHealth(snapshot(), {
    maxSnapshotAgeMs:60000, operations:{},
  }, now);
  assert.equal(result.status, "observed");
  assert.equal(result.operations.length, 10);
  assert.ok(result.operations.every(row =>
    row.expectedState === "unknown" &&
    row.disposition === "configuration_required" &&
    row.observations.length === 0
  ));
  assert.equal(JSON.stringify(result).includes("healthy"), false);
});

for (const name of financialQueueHealthOperations) {
  test("explicit threshold assesses due selected metadata: " + name, () => {
    const report = snapshot();
    selected(report, name);
    const result = assessFinancialQueueHealth(report, {
      maxSnapshotAgeMs:60000,
      operations:{[name]:{expectedState:"running", dueReviewAgeMs:120000}},
    }, now);
    const row = result.operations.find(row => row.operation === name)!;
    assert.equal(row.disposition, "observed");
    assert.deepEqual(row.observations, [
      "selected_metadata_without_feedback", "due_metadata_requires_review",
    ]);
  });
}

test("due age uses snapshot time rather than assessment time", () => {
  const report = snapshot();
  selected(report).oldestDueAt = "2026-10-21T11:58:00.001Z";
  assert.deepEqual(assessed(report).observations, ["selected_metadata_without_feedback"]);
});
test("paused operations suppress due and missing-feedback observations", () => {
  const report = snapshot();
  selected(report);
  const row = assessed(report, policy("paused"));
  assert.equal(row.disposition, "paused");
  assert.deepEqual(row.observations, []);
});
test("unknown operations suppress due and missing-feedback observations", () => {
  const report = snapshot();
  selected(report);
  const row = assessed(report, policy("unknown"));
  assert.equal(row.disposition, "configuration_required");
  assert.deepEqual(row.observations, []);
});
test("running without an age threshold requires configuration", () => {
  const report = snapshot();
  selected(report);
  const rules = policy();
  delete rules.operations[operation].dueReviewAgeMs;
  const row = assessed(report, rules);
  assert.equal(row.disposition, "configuration_required");
  assert.deepEqual(row.observations, ["selected_metadata_without_feedback"]);
});
test("unresolved backoff remains context when paused", () => {
  const report = snapshot();
  Object.assign(report.rows.find(row => row.operation === operation)!, {
    total:"1", cooling:"1", unresolved:"1", backingOff:"1",
    maxReviewFailures:4, oldestReviewedAt:"2026-10-21T11:59:00.000Z",
  });
  assert.deepEqual(assessed(report, policy("paused")).observations, [
    "unresolved_scheduling_metadata", "backoff_in_progress",
  ]);
});
test("resolved due metadata does not imply an eligible financial job", () => {
  const report = snapshot();
  const row = selected(report);
  row.selectedAwaitingFeedback = row.selectedDue = "0";
  row.resolved = "1";
  assert.deepEqual(assessed(report).observations, ["due_metadata_requires_review"]);
});
test("cooling selected metadata has no missing-feedback observation", () => {
  const report = snapshot();
  const row = selected(report);
  row.due = row.selectedDue = "0";
  row.cooling = "1";
  row.oldestDueAt = null;
  assert.deepEqual(assessed(report).observations, []);
});
test("snapshot exactly at maximum age remains usable", () => {
  assert.equal(assessFinancialQueueHealth(snapshot(), policy(),
    new Date("2026-10-21T12:01:00.000Z")).status, "observed");
});
test("stale snapshot is unavailable without per-operation conclusions", () => {
  const result = assessFinancialQueueHealth(snapshot(), policy(),
    new Date("2026-10-21T12:01:00.001Z"));
  assert.equal(result.status, "snapshot_unavailable");
  assert.equal(result.reason, "stale_snapshot");
  assert.deepEqual(result.operations, []);
});
test("future snapshot is unavailable", () => {
  const result = assessFinancialQueueHealth(snapshot(), policy(),
    new Date("2026-10-21T11:59:59.999Z"));
  assert.equal(result.status, "snapshot_unavailable");
  assert.equal(result.reason, "future_snapshot");
  assert.deepEqual(result.operations, []);
});
test("large counts preserve bigint comparisons without precision loss", () => {
  const report = snapshot();
  const row = selected(report);
  row.total = row.due = row.selectedAwaitingFeedback = row.selectedDue = "9007199254740993";
  assert.deepEqual(assessed(report).observations, [
    "selected_metadata_without_feedback", "due_metadata_requires_review",
  ]);
});
test("assessment does not mutate the report or caller policy", () => {
  const report = snapshot();
  selected(report);
  const rules = policy();
  const before = JSON.stringify({report, rules});
  assessFinancialQueueHealth(report, rules, now);
  assert.equal(JSON.stringify({report, rules}), before);
});

for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test("invalid freshness policy is rejected: " + value, () => {
    const rules = policy();
    rules.maxSnapshotAgeMs = value;
    assert.throws(() => assessFinancialQueueHealth(snapshot(), rules, now), /policy/);
  });
}
for (const [name, mutate] of [
  ["missing operation", (r: FinancialQueueHealth) => { r.rows.pop(); }],
  ["duplicate operation", (r: FinancialQueueHealth) => { r.rows[1].operation = r.rows[0].operation; }],
  ["unknown operation", (r: FinancialQueueHealth) => { r.rows[0].operation = "unknown"; }],
  ["numeric count", (r: FinancialQueueHealth) => { r.rows[0].total = 0 as any; }],
  ["negative count", (r: FinancialQueueHealth) => { r.rows[0].due = "-1"; }],
  ["inconsistent total", (r: FinancialQueueHealth) => { r.rows[0].total = "1"; }],
  ["inconsistent outcomes", (r: FinancialQueueHealth) => {
    const row = selected(r); row.resolved = "1";
  }],
  ["due without timestamp", (r: FinancialQueueHealth) => { selected(r).oldestDueAt = null; }],
  ["future due timestamp", (r: FinancialQueueHealth) => {
    selected(r).oldestDueAt = "2026-10-22T00:00:00.000Z";
  }],
  ["invalid failure count", (r: FinancialQueueHealth) => { r.rows[0].maxReviewFailures = 17; }],
] as const) {
  test("malformed snapshot rejected: " + name, () => {
    const report = snapshot();
    mutate(report);
    assert.throws(() => assessFinancialQueueHealth(report, policy(), now), /monitoring/i);
  });
}
test("unknown policy operations and invalid state/threshold fail visibly", () => {
  const rules = policy();
  rules.operations.unknown = {expectedState:"running"};
  assert.throws(() => assessFinancialQueueHealth(snapshot(), rules, now), /policy/);
  delete rules.operations.unknown;
  rules.operations[operation].expectedState = "bad" as any;
  assert.throws(() => assessFinancialQueueHealth(snapshot(), rules, now), /policy/);
  rules.operations[operation].expectedState = "running";
  rules.operations[operation].dueReviewAgeMs = 0;
  assert.throws(() => assessFinancialQueueHealth(snapshot(), rules, now), /policy/);
});
