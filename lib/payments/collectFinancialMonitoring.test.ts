import { test } from "node:test";
import assert from "node:assert/strict";
import { collectFinancialMonitoring as collect } from "./collectFinancialMonitoring";
import { financialQueueHealthOperations as operations } from "./readFinancialQueueHealth";
import type { FinancialQueueHealth } from "./readFinancialQueueHealth";

function fixture() {
  const calls: string[] = [];
  const queueDatabase = {} as any, heartbeatDatabase = {} as any;
  const policy = {
    maxSnapshotAgeMs: 60000, maxHeartbeatAgeMs: 60000,
    operations: Object.fromEntries(operations.map(operation =>
      [operation, {expectedState: "running" as const, dueReviewAgeMs: 30000}]))
  };
  const readers = {
    clock: async () => new Date(),
    queue: async (database: any): Promise<FinancialQueueHealth> => {
      calls.push("queue");
      assert.equal(database, queueDatabase);
      return {
        scope: "scheduling_metadata_only", observedAt: new Date().toISOString(),
        rows: operations.map(operation => ({
          operation, total: "0", due: "0", cooling: "0",
          selectedAwaitingFeedback: "0", selectedDue: "0",
          unresolved: "0", backingOff: "0", resolved: "0", eligible: "0",
          maxReviewFailures: 0, oldestDueAt: null, oldestReviewedAt: null
        }))
      };
    },
    heartbeats: async (database: any) => {
      calls.push("heartbeats");
      assert.equal(database, heartbeatDatabase);
      return [];
    }
  };
  const run = () => collect(queueDatabase, heartbeatDatabase, policy, readers);
  return {calls, policy, readers, run};
}

test("collects both sources once; empty heartbeats remain missing", async () => {
  const f = fixture(), result = await f.run();
  assert.deepEqual(f.calls, ["queue", "heartbeats"]);
  assert.equal(result.queue.status, "available");
  assert.equal(result.heartbeat.status, "available");
  assert.ok(result.operations.every(row => row.heartbeat.status === "missing"));
});

test("queue failure preserves heartbeat collection without retry", async () => {
  const f = fixture();
  f.readers.queue = async () => {
    f.calls.push("queue");
    throw new Error("private database detail");
  };
  const result = await f.run();
  assert.deepEqual(f.calls, ["queue", "heartbeats"]);
  assert.deepEqual(result.queue, {status: "unavailable", reason: "collection_failed"});
  assert.equal(result.heartbeat.status, "available");
  assert.ok(!JSON.stringify(result).includes("private database detail"));
});

test("missing heartbeat schema is visible while queue remains available", async () => {
  const f = fixture();
  f.readers.heartbeats = async () => {
    f.calls.push("heartbeats");
    throw Object.assign(new Error("private schema detail"), {code: "42P01"});
  };
  const result = await f.run();
  assert.equal(result.queue.status, "available");
  assert.deepEqual(result.heartbeat,
    {status: "unavailable", reason: "schema_unavailable"});
  assert.ok(result.operations.every(row => row.heartbeat.status === "unavailable"));
  assert.ok(!JSON.stringify(result).includes("private schema detail"));
});

test("both failures stay unavailable without invented observations", async () => {
  const f = fixture();
  f.readers.queue = async () => {f.calls.push("queue"); throw new Error("queue");};
  f.readers.heartbeats = async () => {f.calls.push("heartbeats"); throw new Error("heartbeat");};
  const result = await f.run();
  assert.deepEqual(f.calls, ["queue", "heartbeats"]);
  assert.ok(result.operations.every(row =>
    row.queue.status === "unavailable" && row.heartbeat.status === "unavailable"));
});

test("invalid policy fails before either reader", async () => {
  const f = fixture();
  f.policy.maxHeartbeatAgeMs = 0;
  await assert.rejects(f.run());
  assert.deepEqual(f.calls, []);
});

test("captures policy before awaiting readers", async () => {
  const f = fixture(), original = f.readers.queue;
  f.readers.queue = async database => {
    f.policy.operations[operations[0]].expectedState = "paused" as any;
    return original(database);
  };
  const result = await f.run();
  assert.equal(result.operations[0].expectedState, "running");
  assert.equal(result.operations[0].heartbeat.status, "missing");
});

test("assessment rejects malformed successful reader output", async () => {
  const f = fixture();
  f.readers.queue = async () => ({invalid: true} as any);
  await assert.rejects(f.run());
  assert.deepEqual(f.calls, ["heartbeats"]);
});

test("database assessment clock handles reports ahead of the application clock", async () => {
  const f = fixture(), readQueue = f.readers.queue;
  const databaseTime = new Date(Date.now() + 3600000);
  f.readers.queue = async database => ({
    ...await readQueue(database), observedAt: databaseTime.toISOString()
  });
  f.readers.clock = async () => databaseTime;
  const result = await f.run();
  assert.equal(result.assessedAt, databaseTime.toISOString());
  assert.equal(result.queue.status, "available");
  if (result.queue.status === "available") {
    assert.equal(result.queue.assessment.status, "observed");
  }
});

test("database clock failure propagates without local-clock substitution", async () => {
  const f = fixture(), failure = new Error("clock unavailable");
  f.readers.clock = async () => {throw failure;};
  await assert.rejects(f.run(), error => error === failure);
  assert.deepEqual(f.calls, ["queue", "heartbeats"]);
});

test("future database snapshot is still rejected against database assessment time", async () => {
  const f = fixture(), readQueue = f.readers.queue;
  const databaseTime = new Date();
  f.readers.clock = async () => databaseTime;
  f.readers.queue = async database => ({
    ...await readQueue(database),
    observedAt: new Date(databaseTime.getTime() + 1).toISOString()
  });
  const result = await f.run();
  assert.equal(result.queue.status, "available");
  if (result.queue.status === "available") {
    assert.equal(result.queue.assessment.status, "snapshot_unavailable");
    assert.equal(result.queue.assessment.reason, "future_snapshot");
  }
});
