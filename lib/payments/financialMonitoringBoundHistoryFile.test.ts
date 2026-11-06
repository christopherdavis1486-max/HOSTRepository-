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


import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  saveBoundFinancialMonitoringHistory as saveBound,
  loadBoundFinancialMonitoringHistory as loadBound
} from "./financialMonitoringBoundHistoryFile";

function folder(work: (directory: string) => void) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "host-bound-history-"));
  try { work(directory); }
  finally { fs.rmSync(directory, {recursive: true, force: true}); }
}

test("bound snapshot reloads pending evidence and preserves earlier snapshots", () => {
  folder(directory => {
    const first = path.join(directory, "first.json");
    const second = path.join(directory, "second.json");
    const state = retain(null, inputs([])).state;
    saveBound(first, state, binding);
    const before = fs.readFileSync(first);
    assert.deepEqual(loadBound(first, binding), state);
    const held = retain(loadBound(first, binding), absent());
    saveBound(second, held.state, binding);
    assert.equal(status(retain(loadBound(second, binding), inputs())), "cleared");
    assert.ok(fs.readFileSync(first).equals(before));
    assert.deepEqual(fs.readdirSync(directory).sort(), ["first.json", "second.json"]);
  });
});

test("wrong identity rejects the load and preserves stored bytes", () => {
  folder(directory => {
    const file = path.join(directory, "snapshot.json");
    saveBound(file, retain(null, inputs([])).state, binding);
    const before = fs.readFileSync(file);
    for (const field of ["environment", "database", "schema"] as const) {
      assert.throws(() => loadBound(file, {
        ...binding, [field]: "different"
      }), /identity mismatch/);
    }
    assert.ok(fs.readFileSync(file).equals(before));
    assert.deepEqual(fs.readdirSync(directory), ["snapshot.json"]);
  });
});

test("existing output is never replaced and temporary files are cleaned", () => {
  folder(directory => {
    const file = path.join(directory, "snapshot.json");
    saveBound(file, retain(null, inputs([])).state, binding);
    const before = fs.readFileSync(file);
    assert.throws(() => saveBound(file, retain(null, inputs()).state, binding),
      (error: any) => error.code === "EEXIST");
    assert.ok(fs.readFileSync(file).equals(before));
    assert.deepEqual(fs.readdirSync(directory), ["snapshot.json"]);
  });
});

test("invalid identity creates no file and legacy or corrupt snapshots fail", () => {
  folder(directory => {
    const file = path.join(directory, "snapshot.json");
    const state = retain(null, inputs()).state;
    assert.throws(() => saveBound(file, state, {...binding, environment: ""}));
    assert.deepEqual(fs.readdirSync(directory), []);
    assert.throws(() => loadBound(file, binding));
    fs.writeFileSync(file, encode(state), {flag: "wx"});
    assert.throws(() => loadBound(file, binding));
    fs.writeFileSync(file, "{");
    assert.throws(() => loadBound(file, binding));
    assert.equal(fs.readFileSync(file, "utf8"), "{");
  });
});
