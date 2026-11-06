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


import {attemptVerifiedFinancialMonitoringEmail as deliver}
  from "./attemptVerifiedFinancialMonitoringEmail";

test("verified opening acceptance permits one matching clearing attempt", async () => {
  await replayFolder(async directory => {
    const history = path.join(directory,"history");
    const attempts = path.join(directory,"attempts");
    fs.mkdirSync(history); fs.mkdirSync(attempts);
    const observations = [inputs([])];
    const first = await advance(history,binding,null,
      async previous => retain(previous,observations[0]).state);
    const source = {directory:history,identity:binding,
      chainId:first.head,observations};
    const recipient = "operator@example.test";
    let calls = 0;
    const sender = async () => {
      calls++;
      return {data:{id:"fixture-"+calls},error:null};
    };
    const opened = await deliver(source,attempts,
      {key:missingKey,kind:"opened",recipient},sender);
    assert.equal(opened.outcome.status,"accepted");
    await assert.rejects(deliver(source,attempts,
      {key:missingKey,kind:"opened",recipient},sender),/resend refused/);

    observations.push(inputs());
    await advance(history,binding,first.head,
      async previous => retain(previous,observations[1]).state);
    // Another recipient cannot reuse this opening acceptance.
    await assert.rejects(deliver(source,attempts,
      {key:missingKey,kind:"cleared",recipient:"other@example.test"},sender));
    assert.equal(calls,1);
    const cleared = await deliver(source,attempts,
      {key:missingKey,kind:"cleared",recipient},sender);
    assert.equal(cleared.outcome.status,"accepted");
    await assert.rejects(deliver(source,attempts,
      {key:missingKey,kind:"cleared",recipient},sender),/resend refused/);
    assert.equal(calls,2);
  });
});

test("uncertain opening cannot authorise clearing and continuing is ineligible", async () => {
  await replayFolder(async directory => {
    const history = path.join(directory,"history");
    const attempts = path.join(directory,"attempts");
    fs.mkdirSync(history); fs.mkdirSync(attempts);
    const observations = [inputs([])];
    const first = await advance(history,binding,null,
      async previous => retain(previous,observations[0]).state);
    const source = {directory:history,identity:binding,
      chainId:first.head,observations};
    const selection = {key:missingKey,kind:"opened" as const,
      recipient:"operator@example.test"};
    let calls=0;
    await deliver(source,attempts,selection,async () => {
      calls++; throw new Error("fixture uncertainty");
    });
    observations.push(inputs([]));
    const second = await advance(history,binding,first.head,
      async previous => retain(previous,observations[1]).state);
    await assert.rejects(deliver(source,attempts,selection,
      async () => {calls++;}),/not eligible/);
    observations.push(inputs());
    await advance(history,binding,second.head,
      async previous => retain(previous,observations[2]).state);
    await assert.rejects(deliver(source,attempts,
      {...selection,kind:"cleared"},async () => {calls++;}),
      /opening acceptance/);
    assert.equal(calls,1);
  });
});
