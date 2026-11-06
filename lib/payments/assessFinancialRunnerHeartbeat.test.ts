import { test } from "node:test";
import assert from "node:assert/strict";
import { financialQueueHealthOperations } from "./readFinancialQueueHealth";
import { assessFinancialRunnerHeartbeat as assess } from "./assessFinancialRunnerHeartbeat";

const now = new Date("2026-10-21T19:00:00.000Z");
const operation = financialQueueHealthOperations[0];
const policy = {
  maxHeartbeatAgeMs: 60000,
  operations: {[operation]: "running" as const}
};
const row = (reports: any[] = [], settings: any = policy) =>
  assess(reports, settings, now).operations.find(r => r.operation === operation)!;

for (const op of financialQueueHealthOperations) {
  test("missing report remains missing for running operation: " + op, () => {
    const result = assess([], {
      maxHeartbeatAgeMs: 60000, operations: {[op]: "running"}
    }, now);
    assert.equal(result.operations.length, 10);
    assert.equal(result.operations.find(r => r.operation === op)!.status, "missing");
  });
}

test("freshness boundary is inclusive; older and future reports are distinct", () => {
  for (const [reportedAt, status] of [
    ["2026-10-21T19:00:00.000Z", "recent"],
    ["2026-10-21T18:59:00.000Z", "recent"],
    ["2026-10-21T18:58:59.999Z", "stale"],
    ["2026-10-21T19:00:00.001Z", "future"]
  ]) {
    assert.equal(row([{operation, reportedAt}]).status, status);
  }
});

test("pause requires explicit policy and preserves supplied report timestamp", () => {
  const reportedAt = "2026-10-20T19:00:00.000Z";
  const settings = {...policy, operations: {[operation]: "paused"}};
  assert.equal(row([], settings).status, "paused");
  const result = row([{operation, reportedAt}], settings);
  assert.equal(result.status, "paused");
  assert.equal(result.reportedAt, reportedAt);
});

test("missing or unknown runner policy requires configuration", () => {
  for (const operations of [{}, {[operation]: "unknown"}]) {
    assert.equal(row([], {...policy, operations}).status, "configuration_required");
  }
});

test("invalid policies and assessment times fail visibly", () => {
  for (const maxHeartbeatAgeMs of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => assess([], {...policy, maxHeartbeatAgeMs}, now));
  }
  for (const operations of [null, [], {unknown_operation: "running"}, {[operation]: "invalid"}]) {
    assert.throws(() => assess([], {...policy, operations} as any, now));
  }
  assert.throws(() => assess([], policy, new Date(NaN)));
});

test("malformed, duplicate and unknown reports fail even when paused", () => {
  const valid = {operation, reportedAt: now.toISOString()};
  const settings = {...policy, operations: {[operation]: "paused" as const}};
  for (const reports of [
    null, {}, [null], [valid, valid],
    [{...valid, operation: "unknown_operation"}],
    [{operation, reportedAt: "invalid"}],
    [{operation, reportedAt: "2026-10-21"}],
    [{operation, reportedAt: 123}]
  ]) {
    assert.throws(() => assess(reports as any, settings, now));
  }
});

test("assessment does not mutate reports or policy", () => {
  const reports = [{operation, reportedAt: now.toISOString()}];
  const before = JSON.stringify({reports, policy});
  assess(reports, policy, now);
  assert.equal(JSON.stringify({reports, policy}), before);
});
