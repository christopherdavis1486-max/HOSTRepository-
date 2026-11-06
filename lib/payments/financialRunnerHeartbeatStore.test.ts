import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { assertSafeTestDatabase } from "../db/testDatabaseGuard";
import { financialQueueHealthOperations } from "./readFinancialQueueHealth";
import {
  startFinancialRunnerHeartbeat as start,
  finishFinancialRunnerHeartbeat as finish,
} from "./financialRunnerHeartbeatStore";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 5000,
  options: "-c statement_timeout=5000 -c lock_timeout=1000"
});
let client: PoolClient;
const operation = financialQueueHealthOperations[0];

before(async () => {
  assertSafeTestDatabase();
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname));
  assert.equal(decodeURIComponent(url.pathname.slice(1)), "host_test");
  client = await pool.connect();
  const identity = (await client.query(
    "SELECT current_database() AS name, host(inet_server_addr()) AS address"
  )).rows[0];
  assert.equal(identity.name, "host_test");
  assert.ok(["127.0.0.1", "::1"].includes(identity.address));
  const sql = fs.readFileSync(
    "migrations/047_financial_runner_heartbeats.sql", "utf8"
  ).replace("CREATE TABLE financial_runner_heartbeats",
    "CREATE TEMP TABLE financial_runner_heartbeats");
  await client.query(sql);
  const resolved = (await client.query(
    "SELECT c.relnamespace = pg_my_temp_schema() AS temporary " +
    "FROM pg_class c WHERE c.oid = 'financial_runner_heartbeats'::regclass"
  )).rows[0];
  assert.equal(resolved.temporary, true);
});
beforeEach(async () => {
  await client.query("TRUNCATE pg_temp.financial_runner_heartbeats");
});
after(async () => {
  if (client) client.release(true);
  await pool.end();
});

async function snapshot(op = operation) {
  return (await client.query(
    "SELECT * FROM pg_temp.financial_runner_heartbeats WHERE operation=$1", [op]
  )).rows[0];
}

for (const op of financialQueueHealthOperations) {
  test("database start and completion: " + op, async () => {
    const token = await start(client, op);
    const started = await snapshot(op);
    assert.equal(started.run_token, token);
    assert.equal(started.outcome, "started");
    assert.equal(started.finished_at, null);
    assert.ok(started.started_at instanceof Date);
    assert.equal(started.reported_at.getTime(), started.started_at.getTime());
    assert.equal(await finish(client, op, token, "returned"), true);
    const completed = await snapshot(op);
    assert.equal(completed.outcome, "returned");
    assert.equal(completed.run_token, token);
    assert.equal(completed.started_at.getTime(), started.started_at.getTime());
    assert.equal(completed.reported_at.getTime(), completed.finished_at.getTime());
    assert.ok(completed.finished_at.getTime() >= started.started_at.getTime());
  });
}

test("a newer start fences older completion and resets prior outcome", async () => {
  const older = await start(client, operation);
  assert.equal(await finish(client, operation, older, "returned"), true);
  const newer = await start(client, operation);
  assert.notEqual(newer, older);
  const before = await snapshot();
  assert.equal(before.outcome, "started");
  assert.equal(before.finished_at, null);
  assert.equal(await finish(client, operation, older, "threw"), false);
  assert.deepEqual(await snapshot(), before);
  assert.equal(await finish(client, operation, newer, "threw"), true);
  assert.equal((await snapshot()).outcome, "threw");
});

test("overlapping unfinished runs retain the newest token", async () => {
  const older = await start(client, operation);
  const newer = await start(client, operation);
  const before = await snapshot();
  assert.equal(await finish(client, operation, older, "returned"), false);
  assert.deepEqual(await snapshot(), before);
  assert.equal(await finish(client, operation, newer, "returned"), true);
});

test("repeated completion cannot overwrite the recorded outcome", async () => {
  const token = await start(client, operation);
  assert.equal(await finish(client, operation, token, "returned"), true);
  const before = await snapshot();
  assert.equal(await finish(client, operation, token, "threw"), false);
  assert.deepEqual(await snapshot(), before);
});

test("absent and wrong-operation tokens do not create or alter records", async () => {
  assert.equal(await finish(client, operation, crypto.randomUUID(), "returned"), false);
  assert.equal(await snapshot(), undefined);
  const token = await start(client, operation);
  const before = await snapshot();
  assert.equal(await finish(client, financialQueueHealthOperations[1], token, "returned"), false);
  assert.deepEqual(await snapshot(), before);
});

test("invalid arguments fail before database access", async () => {
  let calls = 0;
  const database = {query: async () => {
    calls++;
    throw new Error("Unexpected database call");
  }} as any;
  for (const op of ["unknown", "__proto__", null, undefined]) {
    await assert.rejects(start(database, op as any), /Invalid heartbeat operation/);
  }
  for (const token of ["", "invalid", null, undefined]) {
    await assert.rejects(finish(database, operation, token as any, "returned"));
  }
  await assert.rejects(finish(database, operation, crypto.randomUUID(), "invalid" as any));
  assert.equal(calls, 0);
});

test("database errors propagate without retry", async () => {
  const failure = new Error("Injected database failure");
  let calls = 0;
  const database = {query: async () => { calls++; throw failure; }} as any;
  await assert.rejects(start(database, operation), error => error === failure);
  assert.equal(calls, 1);
  await assert.rejects(
    finish(database, operation, crypto.randomUUID(), "returned"),
    error => error === failure
  );
  assert.equal(calls, 2);
});

test("database constraints reject inconsistent completion metadata", async () => {
  await start(client, operation);
  for (const sql of [
    "UPDATE pg_temp.financial_runner_heartbeats SET outcome='invalid'",
    "UPDATE pg_temp.financial_runner_heartbeats SET outcome='returned'",
    "UPDATE pg_temp.financial_runner_heartbeats SET finished_at=started_at",
    "UPDATE pg_temp.financial_runner_heartbeats SET reported_at=started_at-INTERVAL '1 second'",
    "UPDATE pg_temp.financial_runner_heartbeats SET operation='unknown'"
  ]) {
    const before = await snapshot();
    await assert.rejects(client.query(sql), (error: any) => error.code === "23514");
    assert.deepEqual(await snapshot(), before);
  }
});

test("independent operations retain independent monitoring tokens", async () => {
  const a = operation, b = financialQueueHealthOperations[1];
  const first = await start(client, a), second = await start(client, b);
  const before = await snapshot(b);
  await finish(client, a, first, "threw");
  assert.deepEqual(await snapshot(b), before);
  assert.equal(await finish(client, b, second, "returned"), true);
});


test("empty heartbeat storage returns no fabricated reports", async () => {
  const {readFinancialRunnerHeartbeats: read} = await import("./readFinancialRunnerHeartbeats");
  assert.deepEqual(await read(client), []);
});

test("stored heartbeat reports integrate with the assessor", async () => {
  const {readFinancialRunnerHeartbeats: read} = await import("./readFinancialRunnerHeartbeats");
  const {assessFinancialRunnerHeartbeat: assess} = await import("./assessFinancialRunnerHeartbeat");
  const token = await start(client, operation);
  await finish(client, operation, token, "returned");
  const before = await snapshot();
  const records = await read(client);
  assert.equal(records.length, 1);
  assert.equal(records[0].runToken, token);
  assert.equal(records[0].outcome, "returned");
  const assessedAt = new Date(records[0].reportedAt);
  const result = assess(records, {
    maxHeartbeatAgeMs: 60000, operations: {[operation]: "running"}
  }, assessedAt);
  assert.equal(result.operations.find(r => r.operation === operation)!.status, "recent");
  assert.deepEqual(await snapshot(), before);
});

test("reader preserves unfinished and thrown outcomes independently of recency", async () => {
  const {readFinancialRunnerHeartbeats: read} = await import("./readFinancialRunnerHeartbeats");
  const token = await start(client, operation);
  const started = (await read(client))[0];
  assert.equal(started.outcome, "started");
  assert.equal(started.finishedAt, null);
  await finish(client, operation, token, "threw");
  const finished = (await read(client))[0];
  assert.equal(finished.outcome, "threw");
  assert.equal(finished.finishedAt, finished.reportedAt);
});

test("reader rejects malformed database records", async () => {
  const {readFinancialRunnerHeartbeats: read} = await import("./readFinancialRunnerHeartbeats");
  await start(client, operation);
  const valid = await snapshot();
  for (const rows of [
    [{...valid, operation: "unknown"}],
    [valid, valid],
    [{...valid, run_token: "invalid"}],
    [{...valid, outcome: "invalid"}],
    [{...valid, started_at: "2026-10-21"}],
    [{...valid, reported_at: new Date(NaN)}],
    [{...valid, outcome: "returned"}],
    [{...valid, finished_at: valid.reported_at}],
    Array(11).fill(valid)
  ]) {
    await assert.rejects(read({query: async () => ({rows})} as any));
  }
});

test("reader propagates database failure without retry or empty substitution", async () => {
  const {readFinancialRunnerHeartbeats: read} = await import("./readFinancialRunnerHeartbeats");
  const failure = new Error("read failed");
  let calls = 0;
  await assert.rejects(read({query: async () => {
    calls++; throw failure;
  }} as any), error => error === failure);
  assert.equal(calls, 1);
});


test("real heartbeat wrapper preserves callback result and stored outcome", async () => {
  const {runWithFinancialRunnerHeartbeat: wrap} = await import("./runWithFinancialRunnerHeartbeat");
  const value = {status: "disabled", results: []};
  let calls = 0;
  const result = await wrap(client, operation, async () => {
    calls++;
    assert.equal((await snapshot()).outcome, "started");
    return value;
  });
  assert.equal(calls, 1);
  assert.equal(result.execution.status, "returned");
  if (result.execution.status === "returned") assert.equal(result.execution.value, value);
  assert.equal(result.heartbeat.status, "recorded");
  assert.equal((await snapshot()).outcome, "returned");
});

test("real wrapper feedback failure retains result and unfinished metadata without retry", async () => {
  const {runWithFinancialRunnerHeartbeat: wrap} = await import("./runWithFinancialRunnerHeartbeat");
  const failure = new Error("Injected completion-write failure");
  const database = {query: async (sql: string, values: any[]) => {
    if (sql.startsWith("WITH stamp")) throw failure;
    return client.query(sql, values);
  }} as any;
  let calls = 0;
  const value = {callbackReturned: true};
  const result = await wrap(database, operation, async () => {calls++; return value;});
  assert.equal(calls, 1);
  assert.equal(result.execution.status, "returned");
  if (result.execution.status === "returned") assert.equal(result.execution.value, value);
  assert.equal(result.heartbeat.status, "write_failed");
  if (result.heartbeat.status === "write_failed") assert.equal(result.heartbeat.error, failure);
  const row = await snapshot();
  assert.equal(row.outcome, "started");
  assert.equal(row.finished_at, null);
});

test("overlapping real wrapper callbacks fence older completion", async () => {
  const {runWithFinancialRunnerHeartbeat: wrap} = await import("./runWithFinancialRunnerHeartbeat");
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => {release = resolve;});
  const ready = new Promise<void>(resolve => {entered = resolve;});
  let olderCalls = 0, newerCalls = 0;
  const older = wrap(client, operation, async () => {
    olderCalls++;
    entered();
    await waiting;
    return "older";
  });
  let olderResult;
  try {
    await ready;
    const newer = await wrap(client, operation, async () => {
      newerCalls++;
      return "newer";
    });
    assert.equal(newer.heartbeat.status, "recorded");
    const newerRow = await snapshot();
    release();
    olderResult = await older;
    assert.equal(olderResult.heartbeat.status, "superseded");
    assert.deepEqual(await snapshot(), newerRow);
    assert.equal(olderCalls, 1);
    assert.equal(newerCalls, 1);
  } finally {
    release();
    await older;
  }
});
