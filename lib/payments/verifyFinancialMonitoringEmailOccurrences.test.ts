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


import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {advanceFinancialMonitoringHistoryChain as advance}
  from "./advanceFinancialMonitoringHistoryChain";
import {verifyFinancialMonitoringEmailOccurrences as verify}
  from "./verifyFinancialMonitoringEmailOccurrences";

async function replayFolder(work: (directory: string) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "host-occurrence-replay-"));
  try {await work(directory);}
  finally {fs.rmSync(directory, {recursive: true, force: true});}
}

test("committed missing outage clearing and recurrence replay preserves occurrence boundaries", async () => {
  await replayFolder(async directory => {
    const observations = [inputs([]), absent(), inputs(), inputs([])];
    let latest: string | null = null;
    let genesis = "";
    for (const observation of observations) {
      const committed = await advance(directory, binding, latest,
        async previous => retain(previous, observation).state);
      latest = committed.head;
      if (!genesis) genesis = latest;
    }
    const names = fs.readdirSync(directory).sort();
    const before = names.map(name => fs.readFileSync(path.join(directory, name)));
    const result = verify(directory, binding, genesis, observations);
    assert.equal(result.recordCount, 4);
    assert.equal(result.head, latest);
    const opening = result.transitions[0].rows.find(
      row => row.finding.key === missingKey)!;
    const held = result.transitions[1].rows.find(
      row => row.finding.key === missingKey)!;
    const cleared = result.transitions[2].rows.find(
      row => row.finding.key === missingKey)!;
    const reopened = result.transitions[3].rows.find(
      row => row.finding.key === missingKey)!;
    assert.equal(held.status, "unconfirmed");
    assert.equal(cleared.status, "cleared");
    assert.equal(held.occurrence.id, opening.occurrence.id);
    assert.equal(cleared.occurrence.id, opening.occurrence.id);
    assert.notEqual(reopened.occurrence.id, opening.occurrence.id);
    assert.equal(result.state.active.length, 10);
    assert.deepEqual(fs.readdirSync(directory).sort(), names);
    names.forEach((name,index) =>
      assert.ok(fs.readFileSync(path.join(directory,name)).equals(before[index])));
  });
});

test("wrong observations incomplete replay and wrong chain or source are rejected", async () => {
  await replayFolder(async directory => {
    const observation = inputs([]);
    const committed = await advance(directory, binding, null,
      async previous => retain(previous, observation).state);
    assert.throws(() => verify(directory,binding,committed.head,[]));
    assert.throws(() => verify(directory,binding,committed.head,[inputs()]),
      /do not match/);
    assert.throws(() => verify(directory,binding,"f".repeat(64),[observation]),
      /chain identity/);
    assert.throws(() => verify(directory,{...binding,schema:"other"},
      committed.head,[observation]), /identity mismatch/);
  });
});

test("empty chain and existing lock are refused without changing files", async () => {
  await replayFolder(async directory => {
    assert.throws(() => verify(directory,binding,"a".repeat(64),[]));
    assert.deepEqual(fs.readdirSync(directory),[]);
    const observation = inputs([]);
    const committed = await advance(directory,binding,null,
      async previous => retain(previous,observation).state);
    const lockFile = path.join(directory,".chain.lock");
    fs.writeFileSync(lockFile,"fixture-owner",{flag:"wx"});
    assert.throws(() => verify(directory,binding,committed.head,[observation]),
      /lock present/);
    assert.equal(fs.readFileSync(lockFile,"utf8"),"fixture-owner");
  });
});
