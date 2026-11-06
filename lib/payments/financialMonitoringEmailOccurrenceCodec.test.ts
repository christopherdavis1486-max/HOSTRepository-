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


import {
  encodeFinancialMonitoringEmailOccurrences as encodeOccurrences,
  decodeFinancialMonitoringEmailOccurrences as decodeOccurrences
} from "./financialMonitoringEmailOccurrenceCodec";

test("occurrence round trip restores evidence dates and supports continuation", () => {
  const first = track(null, inputs([]), binding, chainId, head(1));
  const before = structuredClone(first.state);
  const restored = decodeOccurrences(
    encodeOccurrences(first.state), binding, chainId);
  assert.deepEqual(restored, before);
  assert.ok(restored.history.pending[0].evidence[3] instanceof Date);
  assert.deepEqual(first.state, before);
  const held = track(restored, absent(), binding, chainId, head(2));
  assert.equal(held.state.active.length, 11);
  assert.equal(held.state.active.find(row => row.key === missingKey)!.id,
    first.state.active.find(row => row.key === missingKey)!.id);
});

test("empty active state round trips and clearing remains closed", () => {
  const first = track(null, inputs([]), binding, chainId, head(1));
  const cleared = track(first.state, inputs(), binding, chainId, head(2));
  const restored = decodeOccurrences(
    encodeOccurrences(cleared.state), binding, chainId);
  assert.equal(restored.active.length, 0);
  assert.equal(restored.history.pending.length, 0);
  const next = track(restored, inputs(), binding, chainId, head(3));
  assert.equal(next.transitions.length, 0);
});

test("wrong source or chain is rejected including empty state", () => {
  for (const observation of [inputs([]), inputs()]) {
    const state = track(null, observation, binding, chainId, head(1)).state;
    const text = encodeOccurrences(state);
    for (const field of ["environment", "database", "schema"] as const) {
      assert.throws(() => decodeOccurrences(text,
        {...binding, [field]: "different"}, chainId));
    }
    assert.throws(() => decodeOccurrences(text, binding, "b".repeat(64)));
  }
});

test("duplicate missing and fabricated occurrence metadata is rejected", () => {
  const state = track(null, inputs([]), binding, chainId, head(1)).state;
  const original = encodeOccurrences(state);
  for (const change of [
    (row: any) => {row.active.push({...row.active[0]});},
    (row: any) => {row.active.pop();},
    (row: any) => {row.active[0].id = "f".repeat(64);},
    (row: any) => {row.active[0].extra = true;},
    (row: any) => {row.lastHead = "invalid";},
    (row: any) => {row.version = 2;},
    (row: any) => {row.extra = true;}
  ]) {
    const changed = JSON.parse(original);
    change(changed);
    assert.throws(() => decodeOccurrences(JSON.stringify(changed), binding, chainId));
  }
  assert.equal(encodeOccurrences(state), original);
});

test("malformed evidence oversized text and invalid encoder state fail", () => {
  const state = track(null, inputs([]), binding, chainId, head(1)).state;
  const changed = JSON.parse(encodeOccurrences(state));
  changed.snapshot.history.state.pending[0].key = "invented:condition";
  assert.throws(() => decodeOccurrences(JSON.stringify(changed), binding, chainId));
  assert.throws(() => decodeOccurrences("{", binding, chainId));
  assert.throws(() => decodeOccurrences(
    " ".repeat(2 * 1024 * 1024 + 1), binding, chainId));
  const invalid = structuredClone(state);
  invalid.active[0].id = "invalid";
  const before = structuredClone(invalid);
  assert.throws(() => encodeOccurrences(invalid));
  assert.deepEqual(invalid, before);
});
