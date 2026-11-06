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


import {
  encodeFinancialMonitoringAlertHistory as encode,
  decodeFinancialMonitoringAlertHistory as decode
} from "./financialMonitoringAlertHistoryCodec";


import {
  encodeBoundFinancialMonitoringHistory as encodeBound,
  decodeBoundFinancialMonitoringHistory as decodeBound
} from "./financialMonitoringBoundHistoryCodec";

const binding = {
  environment: "local-rehearsal",
  database: "host_test",
  schema: "fixture_a"
};

test("bound history restores pending evidence without mutating inputs", () => {
  const state = retain(null, inputs([])).state;
  const before = structuredClone(state);
  const identityBefore = structuredClone(binding);
  const restored = decodeBound(encodeBound(state, binding), binding);
  assert.deepEqual(restored, before);
  assert.ok(restored.pending[0].evidence[3] instanceof Date);
  assert.deepEqual(state, before);
  assert.deepEqual(binding, identityBefore);
  const held = retain(restored, absent());
  assert.equal(status(held), "unconfirmed");
  assert.equal(status(retain(held.state, inputs())), "cleared");
});

test("each identity component must match including empty histories", () => {
  for (const state of [
    retain(null, inputs([])).state, retain(null, inputs()).state
  ]) {
    const text = encodeBound(state, binding);
    for (const field of ["environment", "database", "schema"] as const) {
      assert.throws(() => decodeBound(text, {
        ...binding, [field]: "different"
      }), /identity mismatch/);
    }
  }
});

test("unbound history and unsupported versions are rejected", () => {
  const state = retain(null, inputs()).state;
  assert.throws(() => decodeBound(encode(state), binding));
  for (const version of [null, 1, 3, "2"]) {
    assert.throws(() => decodeBound(JSON.stringify({
      version, identity: binding,
      history: JSON.parse(encode(state))
    }), binding));
  }
});

test("missing malformed and extra identity fields are rejected", () => {
  const state = retain(null, inputs()).state;
  const text = encodeBound(state, binding);
  for (const invalid of [
    null, [], {}, {...binding, schema: ""},
    {...binding, environment: " local"},
    {...binding, database: "postgres://private"},
    {...binding, schema: "x".repeat(129)},
    {...binding, extra: "unexpected"}
  ]) {
    assert.throws(() => encodeBound(state, invalid as any));
    assert.throws(() => decodeBound(text, invalid as any));
    const changed = JSON.parse(text);
    changed.identity = invalid;
    assert.throws(() => decodeBound(JSON.stringify(changed), binding));
  }
});

test("bound decoding retains condition validation and input size limits", () => {
  const state = retain(null, inputs([])).state;
  const changed = JSON.parse(encodeBound(state, binding));
  changed.history.state.pending[0].key = "invented:condition";
  assert.throws(() => decodeBound(JSON.stringify(changed), binding));
  assert.throws(() => decodeBound("{", binding));
  assert.throws(() => decodeBound(" ".repeat(1024 * 1024 + 1), binding));
});
