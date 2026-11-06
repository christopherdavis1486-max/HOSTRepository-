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
import {spawnSync} from "node:child_process";

const child = "\nconst fs=require(\"node:fs\"),path=require(\"node:path\");\nconst [previous,observationFile,next]=process.argv.slice(1);\nconst {\n  loadFinancialMonitoringAlertHistory:load,\n  saveFinancialMonitoringAlertHistory:save\n}=require(path.resolve(\"lib/payments/financialMonitoringAlertHistoryFile.ts\"));\nconst {retainFinancialMonitoringAlerts:retain}=\n  require(path.resolve(\"lib/payments/retainFinancialMonitoringAlerts.ts\"));\ntry {\n  const observation=JSON.parse(fs.readFileSync(observationFile,\"utf8\"));\n  observation[3]=new Date(observation[3]);\n  const result=retain(previous===\"-\"?null:load(previous),observation);\n  save(next,result.state);\n  console.log(JSON.stringify({\n    pid:process.pid,\n    pending:result.state.pending.map(row=>row.key),\n    transitions:result.transitions\n  }));\n} catch {\n  console.error(\"History restart fixture failed\");\n  process.exitCode=1;\n}\n";

function restart(previous: string, observation: string, next: string) {
  return spawnSync(process.execPath, [
    "--import", "tsx", "-e", child, previous, observation, next
  ], {
    encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024
  });
}
function temporary(work: (directory: string) => void) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "host-history-restart-"));
  try { work(directory); }
  finally { fs.rmSync(directory, {recursive: true, force: true}); }
}
function observationFile(directory: string, name: string, value: AlertInputs) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, JSON.stringify(value), {flag: "wx"});
  return file;
}
function successful(result: ReturnType<typeof restart>) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  return JSON.parse(result.stdout);
}

test("separate processes retain missing conditions through outage and later clear", () => {
  temporary(directory => {
    const missing = observationFile(directory, "missing.json", inputs([]));
    const outage = observationFile(directory, "outage.json", absent());
    const healthy = observationFile(directory, "healthy.json", inputs());
    const first = path.join(directory, "first.json");
    const second = path.join(directory, "second.json");
    const third = path.join(directory, "third.json");

    const opened = successful(restart("-", missing, first));
    assert.notEqual(opened.pid, process.pid);
    assert.equal(opened.pending.length, 10);
    assert.ok(opened.transitions.every((row: any) => row.status === "opened"));
    const firstBytes = fs.readFileSync(first);

    const held = successful(restart(first, outage, second));
    assert.notEqual(held.pid, process.pid);
    assert.equal(held.pending.length, 11);
    assert.equal(held.transitions.find((row: any) =>
      row.finding.key === missingKey).status, "unconfirmed");
    assert.ok(fs.readFileSync(first).equals(firstBytes));
    const secondBytes = fs.readFileSync(second);

    const cleared = successful(restart(second, healthy, third));
    assert.notEqual(cleared.pid, process.pid);
    assert.equal(cleared.pending.length, 0);
    assert.equal(cleared.transitions.length, 11);
    assert.ok(cleared.transitions.every((row: any) => row.status === "cleared"));
    assert.ok(fs.readFileSync(first).equals(firstBytes));
    assert.ok(fs.readFileSync(second).equals(secondBytes));
    assert.equal(decode(fs.readFileSync(third, "utf8")).pending.length, 0);
  });
});

test("fresh process rejects corrupt previous snapshot without creating next state", () => {
  temporary(directory => {
    const observation = observationFile(directory, "observation.json", inputs());
    const previous = path.join(directory, "previous.json");
    const next = path.join(directory, "next.json");
    fs.writeFileSync(previous, "{", {flag: "wx"});
    const result = restart(previous, observation, next);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /History restart fixture failed/);
    assert.equal(fs.existsSync(next), false);
    assert.equal(fs.readFileSync(previous, "utf8"), "{");
  });
});

test("fresh process preserves an existing next snapshot", () => {
  temporary(directory => {
    const observation = observationFile(directory, "observation.json", inputs([]));
    const next = path.join(directory, "next.json");
    successful(restart("-", observation, next));
    const before = fs.readFileSync(next);
    const result = restart("-", observation, next);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(fs.readFileSync(next).equals(before));
    assert.deepEqual(fs.readdirSync(directory).sort(),
      ["next.json", "observation.json"]);
  });
});
