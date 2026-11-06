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


import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  saveFinancialMonitoringAlertHistory as save,
  loadFinancialMonitoringAlertHistory as load
} from "./financialMonitoringAlertHistoryFile";

function folder(work: (directory: string) => void) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "host-alert-file-"));
  try { work(directory); }
  finally { fs.rmSync(directory, {recursive: true, force: true}); }
}

test("saved snapshot reloads pending conditions and cleans temporary files", () => {
  folder(directory => {
    const file = path.join(directory, "snapshot.json");
    const state = retain(null, inputs([])).state;
    save(file, state);
    assert.deepEqual(load(file), state);
    assert.deepEqual(fs.readdirSync(directory), ["snapshot.json"]);
    const restored = retain(load(file), absent());
    assert.equal(status(restored), "unconfirmed");
    assert.equal(status(retain(restored.state, inputs())), "cleared");
  });
});

test("existing snapshot is preserved and failed publication cleans its temporary file", () => {
  folder(directory => {
    const file = path.join(directory, "snapshot.json");
    save(file, retain(null, inputs([])).state);
    const before = fs.readFileSync(file);
    assert.throws(() => save(file, retain(null, inputs()).state),
      (error: any) => error.code === "EEXIST");
    assert.ok(fs.readFileSync(file).equals(before));
    assert.deepEqual(fs.readdirSync(directory), ["snapshot.json"]);
  });
});

test("invalid state fails before any snapshot or temporary file is created", () => {
  folder(directory => {
    const state = retain(null, inputs([])).state;
    state.pending[0].key = "invented:condition";
    assert.throws(() => save(path.join(directory, "snapshot.json"), state));
    assert.deepEqual(fs.readdirSync(directory), []);
  });
});

test("missing, corrupt, oversized and directory loads fail without empty substitution", () => {
  folder(directory => {
    const file = path.join(directory, "snapshot.json");
    assert.throws(() => load(file), (error: any) => error.code === "ENOENT");
    fs.writeFileSync(file, "{");
    assert.throws(() => load(file));
    fs.writeFileSync(file, " ".repeat(1024 * 1024 + 1));
    assert.throws(() => load(file));
    assert.throws(() => load(directory));
  });
});

test("unpublished partial temporary file is ignored when loading an explicit snapshot", () => {
  folder(directory => {
    const file = path.join(directory, "snapshot.json");
    const state = retain(null, inputs([])).state;
    save(file, state);
    fs.writeFileSync(path.join(directory, ".host-alert-interrupted.tmp"), "{");
    assert.deepEqual(load(file), state);
    assert.throws(() => load(path.join(directory, ".host-alert-interrupted.tmp")));
  });
});

test("missing parent directory fails without creating directories", () => {
  folder(directory => {
    assert.throws(() => save(
      path.join(directory, "absent", "snapshot.json"),
      retain(null, inputs([])).state
    ));
    assert.deepEqual(fs.readdirSync(directory), []);
  });
});
