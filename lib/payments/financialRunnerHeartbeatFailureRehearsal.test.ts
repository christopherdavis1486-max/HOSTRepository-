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

  await client.query(
    "CREATE FUNCTION pg_temp.reject_heartbeat_fixture_write() RETURNS trigger " +
    "LANGUAGE plpgsql AS $body$ BEGIN " +
    "IF current_setting('host.heartbeat_fail_phase',true)=TG_OP THEN " +
    "RAISE EXCEPTION 'Injected heartbeat fixture write rejection' USING ERRCODE='42501'; " +
    "END IF; RETURN NEW; END $body$"
  );
  await client.query(
    "CREATE TRIGGER reject_heartbeat_fixture_write " +
    "BEFORE INSERT OR UPDATE ON pg_temp.financial_runner_heartbeats " +
    "FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_heartbeat_fixture_write()"
  );
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


import {spawn} from "node:child_process";
import {runWithFinancialRunnerHeartbeat as wrap} from "./runWithFinancialRunnerHeartbeat";
import {readFinancialRunnerHeartbeats as read} from "./readFinancialRunnerHeartbeats";
import {assessFinancialRunnerHeartbeat as assess} from "./assessFinancialRunnerHeartbeat";

const childSource = "\nconst path=require(\"node:path\");\nconst {runWithFinancialRunnerHeartbeat:wrap}=\n  require(path.resolve(\"lib/payments/runWithFinancialRunnerHeartbeat.ts\"));\nlet sequence=0;\nconst waiting=new Map();\nprocess.on(\"message\",message=>{\n  const request=waiting.get(message.id);\n  if(!request) return;\n  waiting.delete(message.id);\n  if(message.error) request.reject(new Error(message.error));\n  else request.resolve({rows:message.rows});\n});\nconst database={query:(sql,values)=>new Promise((resolve,reject)=>{\n  const id=++sequence;\n  waiting.set(id,{resolve,reject});\n  process.send({kind:\"query\",id,sql,values});\n})};\nwrap(database,process.argv[1],async()=>{\n  process.send({kind:\"entered\"});\n  await new Promise(()=>{setInterval(()=>{},1000);});\n}).then(()=>{\n  process.send({kind:\"unexpected_return\"});\n}).catch(()=>{\n  process.send({kind:\"unexpected_failure\"});\n});\n";




test("real start-write failure prevents callback invocation", async () => {
  let calls = 0;
  await client.query("SELECT set_config('host.heartbeat_fail_phase','INSERT',false)");
  try {
    await assert.rejects(wrap(client, operation, async () => {calls++;}),
      (error: any) => error.code === "42501");
    assert.equal(calls, 0);
    assert.equal(await snapshot(), undefined);
  } finally {
    await client.query("SELECT set_config('host.heartbeat_fail_phase','',false)");
  }
});

test("real completion-write failure preserves callback result without retry", async () => {
  let calls = 0;
  const value = {fixtureCompleted: true};
  try {
    const result = await wrap(client, operation, async () => {
      calls++;
      await client.query("SELECT set_config('host.heartbeat_fail_phase','UPDATE',false)");
      return value;
    });
    assert.equal(calls, 1);
    assert.equal(result.execution.status, "returned");
    if (result.execution.status === "returned") {
      assert.equal(result.execution.value, value);
    }
    assert.equal(result.heartbeat.status, "write_failed");
    if (result.heartbeat.status === "write_failed") {
      assert.equal((result.heartbeat.error as any).code, "42501");
    }
    const row = await snapshot();
    assert.equal(row.outcome, "started");
    assert.equal(row.finished_at, null);
    assert.equal(calls, 1);
  } finally {
    await client.query("SELECT set_config('host.heartbeat_fail_phase','',false)");
  }
});

test("terminated fixture callback leaves unfinished heartbeat that becomes stale", async () => {
  const child = spawn(process.execPath, [
    "--import", "tsx", "-e", childSource, operation
  ], {stdio: ["ignore", "pipe", "pipe", "ipc"]});
  let entered = 0, queries = 0, failure: Error | undefined;
  let stdout = "", stderr = "";
  child.stdout!.on("data", chunk => {stdout += String(chunk);});
  child.stderr!.on("data", chunk => {stderr += String(chunk);});
  const timer = setTimeout(() => {
    failure = new Error("Interrupted callback rehearsal exceeded deadline");
    child.kill("SIGKILL");
  }, 15000);
  try {
    const closed = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
    child.on("message", (message: any) => {
      if (message.kind === "query") {
        queries++;
        void client.query(message.sql, message.values).then(result => {
          if (child.connected) child.send(
            {id: message.id, rows: result.rows}, () => {});
        }).catch(error => {
          failure = error;
          child.kill("SIGKILL");
        });
      } else if (message.kind === "entered") {
        entered++;
        child.kill("SIGKILL");
      } else {
        failure = new Error("Unexpected fixture callback outcome");
        child.kill("SIGKILL");
      }
    });
    await closed;
    if (failure) throw failure;
    assert.equal(entered, 1);
    assert.equal(queries, 1, "Only the start write may occur");
    assert.equal(stdout, "");
    assert.equal(stderr, "");
    const before = await snapshot();
    assert.equal(before.outcome, "started");
    assert.equal(before.finished_at, null);
    const records = await read(client);
    const assessedAt = new Date(Date.parse(records[0].reportedAt) + 60001);
    const result = assess(records, {
      maxHeartbeatAgeMs: 60000, operations: {[operation]: "running"}
    }, assessedAt);
    assert.equal(result.operations.find(row => row.operation === operation)!.status,
      "stale");
    assert.deepEqual(await snapshot(), before);
    assert.equal(entered, 1);
    assert.equal(queries, 1);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
