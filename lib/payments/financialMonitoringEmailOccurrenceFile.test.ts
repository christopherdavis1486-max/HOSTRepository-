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


import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  saveFinancialMonitoringEmailOccurrences as saveOccurrences,
  loadFinancialMonitoringEmailOccurrences as loadOccurrences
} from "./financialMonitoringEmailOccurrenceFile";

function folder(work: (directory: string) => void) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "host-occurrence-files-"));
  try {work(directory);}
  finally {fs.rmSync(directory, {recursive: true, force: true});}
}

test("saved occurrence reloads evidence and continues without changing predecessor", () => {
  folder(directory => {
    const firstFile = path.join(directory, "first.json");
    const secondFile = path.join(directory, "second.json");
    const first = track(null, inputs([]), binding, chainId, head(1));
    saveOccurrences(firstFile, first.state);
    const before = fs.readFileSync(firstFile);
    const restored = loadOccurrences(firstFile, binding, chainId);
    assert.deepEqual(restored, first.state);
    assert.ok(restored.history.pending[0].evidence[3] instanceof Date);
    const held = track(restored, absent(), binding, chainId, head(2));
    saveOccurrences(secondFile, held.state);
    const reloaded = loadOccurrences(secondFile, binding, chainId);
    const cleared = track(reloaded, inputs(), binding, chainId, head(3));
    assert.equal(cleared.state.active.length, 0);
    assert.ok(fs.readFileSync(firstFile).equals(before));
    assert.deepEqual(fs.readdirSync(directory).sort(),
      ["first.json", "second.json"]);
  });
});

test("existing occurrence snapshot is preserved and temporary file cleaned", () => {
  folder(directory => {
    const file = path.join(directory, "state.json");
    const state = track(null, inputs([]), binding, chainId, head(1)).state;
    saveOccurrences(file, state);
    const before = fs.readFileSync(file);
    assert.throws(() => saveOccurrences(file, state),
      (error: any) => error.code === "EEXIST");
    assert.ok(fs.readFileSync(file).equals(before));
    assert.deepEqual(fs.readdirSync(directory), ["state.json"]);
  });
});

test("wrong source or chain and corrupt snapshots fail without substitution", () => {
  folder(directory => {
    const file = path.join(directory, "state.json");
    assert.throws(() => loadOccurrences(file, binding, chainId));
    saveOccurrences(file,
      track(null, inputs([]), binding, chainId, head(1)).state);
    const before = fs.readFileSync(file);
    assert.throws(() => loadOccurrences(file,
      {...binding, schema: "other"}, chainId));
    assert.throws(() => loadOccurrences(file, binding, "b".repeat(64)));
    assert.ok(fs.readFileSync(file).equals(before));
    fs.writeFileSync(file, "{");
    assert.throws(() => loadOccurrences(file, binding, chainId));
    assert.equal(fs.readFileSync(file, "utf8"), "{");
    assert.throws(() => loadOccurrences(directory, binding, chainId));
  });
});

test("invalid state and missing parent create no snapshot or directories", () => {
  folder(directory => {
    const state = track(null, inputs([]), binding, chainId, head(1)).state;
    const invalid = structuredClone(state);
    invalid.active[0].id = "invalid";
    assert.throws(() => saveOccurrences(path.join(directory, "invalid.json"), invalid));
    assert.throws(() => saveOccurrences(
      path.join(directory, "absent", "state.json"), state),
      (error: any) => error.code === "ENOENT");
    assert.deepEqual(fs.readdirSync(directory), []);
  });
});
