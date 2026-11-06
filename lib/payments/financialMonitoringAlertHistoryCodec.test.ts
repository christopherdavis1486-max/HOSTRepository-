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

test("JSON round trip restores Date objects and retains pending evidence", () => {
  const result = retain(null, inputs([]));
  const before = structuredClone(result.state);
  const restored = decode(encode(result.state));
  assert.deepEqual(restored, before);
  assert.ok(restored.pending[0].evidence[3] instanceof Date);
  assert.deepEqual(result.state, before);
});

test("restored conditions survive another outage and later clear", () => {
  let result = retain(null, inputs([]));
  result = retain(result.state, absent());
  const restored = decode(encode(result.state));
  result = retain(restored, absent());
  assert.equal(status(result), "unconfirmed");
  result = retain(result.state, inputs());
  assert.equal(status(result), "cleared");
  assert.equal(result.state.pending.length, 0);
});

test("empty history round trips without fabricating pending conditions", () => {
  const state = retain(null, inputs()).state;
  assert.deepEqual(decode(encode(state)), state);
  assert.equal(state.pending.length, 0);
});

test("malformed JSON and unsupported formats fail visibly", () => {
  for (const text of [
    "", "{", "null", "[]", "{}",
    JSON.stringify({version: 2, state: {assessedAt: now.toISOString(), pending: []}}),
    JSON.stringify({version: 1, state: {assessedAt: "invalid", pending: []}})
  ]) assert.throws(() => decode(text));
});

test("stored duplicate keys and fabricated conditions are rejected", () => {
  const valid = JSON.parse(encode(retain(null, inputs([])).state));
  const duplicate = structuredClone(valid);
  duplicate.state.pending.push(structuredClone(duplicate.state.pending[0]));
  assert.throws(() => decode(JSON.stringify(duplicate)));
  const fabricated = structuredClone(valid);
  fabricated.state.pending[0].key = "invented:condition";
  assert.throws(() => decode(JSON.stringify(fabricated)));
});

test("stored evidence dates and source records are validated", () => {
  const valid = JSON.parse(encode(retain(null, inputs([])).state));
  for (const timestamp of [null, 0, "invalid", "2026-10-21"]) {
    const changed = structuredClone(valid);
    changed.state.pending[0].evidence[3] = timestamp;
    assert.throws(() => decode(JSON.stringify(changed)));
  }
  const changed = structuredClone(valid);
  changed.state.pending[0].evidence[1] = available([record(), record()]);
  assert.throws(() => decode(JSON.stringify(changed)));
  const earlier = structuredClone(valid);
  earlier.state.assessedAt = new Date(now.getTime() - 1).toISOString();
  assert.throws(() => decode(JSON.stringify(earlier)));
});

test("oversized input and excessive condition counts are rejected", () => {
  assert.throws(() => decode(" ".repeat(1024 * 1024 + 1)));
  const valid = JSON.parse(encode(retain(null, inputs([])).state));
  valid.state.pending = Array(257).fill(valid.state.pending[0]);
  assert.throws(() => decode(JSON.stringify(valid)));
});

test("encoder rejects invalid state without mutating it", () => {
  const state = retain(null, inputs([])).state;
  state.pending[0].key = "invented:condition";
  const before = structuredClone(state);
  assert.throws(() => encode(state));
  assert.deepEqual(state, before);
});
