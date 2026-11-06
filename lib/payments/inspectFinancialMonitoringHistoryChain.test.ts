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
import {spawnSync} from "node:child_process";
import {advanceFinancialMonitoringHistoryChain as advance}
  from "./advanceFinancialMonitoringHistoryChain";
import {inspectFinancialMonitoringHistoryChain as inspect}
  from "./inspectFinancialMonitoringHistoryChain";

async function folder(work: (directory: string) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "host-chain-inspect-"));
  try { await work(directory); }
  finally { fs.rmSync(directory, {recursive: true, force: true}); }
}
function bytes(directory: string) {
  return fs.readdirSync(directory).sort().map(name => ({
    name, content: fs.readFileSync(path.join(directory, name))
  }));
}

test("empty chain inspection creates no files", async () => {
  await folder(async directory => {
    const result = inspect(directory, binding);
    assert.equal(result.recordCount, 0);
    assert.equal(result.head, null);
    assert.equal(result.file, null);
    assert.equal(result.state, null);
    assert.deepEqual(fs.readdirSync(directory), []);
  });
});

test("inspection validates pending evidence and reports the latest head without changes", async () => {
  await folder(async directory => {
    const first = await advance(directory, binding, null,
      async () => retain(null, inputs([])).state);
    const second = await advance(directory, binding, first.head,
      async previous => retain(previous, absent()).state);
    const before = bytes(directory);
    const result = inspect(directory, binding);
    assert.equal(result.recordCount, 2);
    assert.equal(result.head, second.head);
    assert.equal(result.file, second.file);
    assert.deepEqual(result.state, second.state);
    assert.ok(result.state!.pending[0].evidence[3] instanceof Date);
    result.state!.pending[0].evidence[3].setTime(0);
    assert.deepEqual(inspect(directory, binding).state, second.state);
    assert.deepEqual(bytes(directory), before);
  });
});

test("wrong identity is rejected without changing records", async () => {
  await folder(async directory => {
    await advance(directory, binding, null, async () => retain(null, inputs([])).state);
    const before = bytes(directory);
    assert.throws(() => inspect(directory,
      {...binding, environment: "different"}), /identity mismatch/);
    assert.deepEqual(bytes(directory), before);
  });
});

test("existing lock is preserved and inspection is refused", async () => {
  await folder(async directory => {
    await advance(directory, binding, null, async () => retain(null, inputs()).state);
    fs.writeFileSync(path.join(directory, ".chain.lock"), "owner-preserved");
    const before = bytes(directory);
    assert.throws(() => inspect(directory, binding), /lock present/);
    assert.deepEqual(bytes(directory), before);
  });
});

test("broken linkage and fabricated retained evidence are rejected unchanged", async () => {
  await folder(async directory => {
    const first = await advance(directory, binding, null,
      async () => retain(null, inputs([])).state);
    const original = fs.readFileSync(first.file);
    for (const mode of ["link", "evidence"]) {
      const record = JSON.parse(original.toString("utf8"));
      if (mode === "link") record.previousHead = "a".repeat(64);
      else record.snapshot.history.state.pending[0].key = "invented:condition";
      fs.writeFileSync(first.file, JSON.stringify(record));
      const before = bytes(directory);
      assert.throws(() => inspect(directory, binding));
      assert.deepEqual(bytes(directory), before);
    }
  });
});

test("sequence gaps and leftover temporary files are preserved and rejected", async () => {
  await folder(async directory => {
    const first = await advance(directory, binding, null,
      async () => retain(null, inputs()).state);
    const moved = path.join(directory, "00000002.json");
    fs.renameSync(first.file, moved);
    let before = bytes(directory);
    assert.throws(() => inspect(directory, binding), /sequence gap/);
    assert.deepEqual(bytes(directory), before);
    fs.renameSync(moved, first.file);
    fs.writeFileSync(path.join(directory, ".record-interrupted.tmp"), "{");
    before = bytes(directory);
    assert.throws(() => inspect(directory, binding), /Unexpected/);
    assert.deepEqual(bytes(directory), before);
  });
});

test("inspection CLI reports stored pending count and redacts failure paths", async () => {
  await folder(async directory => {
    const chain = path.join(directory, "chain");
    fs.mkdirSync(chain);
    const identityFile = path.join(directory, "identity.json");
    fs.writeFileSync(identityFile, JSON.stringify(binding));
    const first = await advance(chain, binding, null,
      async () => retain(null, inputs([])).state);
    const before = bytes(chain);
    const run = () => spawnSync(process.execPath, [
      "--import", "tsx", "scripts/inspectFinancialMonitoringHistoryChain.ts",
      chain, identityFile
    ], {encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024});
    const good = run();
    assert.equal(good.error, undefined);
    assert.equal(good.signal, null);
    assert.equal(good.status, 0, good.stderr);
    assert.equal(good.stderr, "");
    const report = JSON.parse(good.stdout);
    assert.equal(report.head, first.head);
    assert.equal(report.pendingCount, 10);
    assert.deepEqual(bytes(chain), before);
    fs.writeFileSync(path.join(chain, ".chain.lock"), "owner-preserved");
    const locked = bytes(chain);
    const failed = run();
    assert.equal(failed.error, undefined);
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, "");
    assert.match(failed.stderr, /history inspection failed/);
    assert.ok(!failed.stderr.includes(directory));
    assert.deepEqual(bytes(chain), locked);
  });
});
