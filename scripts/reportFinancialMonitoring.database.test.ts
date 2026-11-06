import { test, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { Pool, type PoolClient } from "pg";
import {
  readFinancialQueueHealth,
  financialQueueHealthOperations,
} from "../lib/payments/readFinancialQueueHealth";

const definitions = [
  ["042_cancellation_settlement_queue_reviews.sql", "cancellation_settlement_queue_reviews", "settlement_id", ["settlement_execute", "settlement_reconcile"]],
  ["043_new_flow_payment_queue_reviews.sql", "new_flow_payment_queue_reviews", "payment_attempt_id", ["payment_reconcile", "missing_refund_recover"]],
  ["044_new_flow_refund_queue_reviews.sql", "new_flow_refund_queue_reviews", "refund_id", ["refund_execute", "refund_reconcile"]],
  ["045_host_transfer_queue_reviews.sql", "host_transfer_queue_reviews", "entitlement_id", ["transfer_execute", "transfer_reconcile"]],
  ["046_transfer_reversal_queue_reviews.sql", "transfer_reversal_queue_reviews", "reversal_id", ["reversal_execute", "reversal_reconcile"]],
] as const;
const pool = new Pool({
  connectionString:process.env.DATABASE_URL, max:2,
  connectionTimeoutMillis:5000,
  options:"-c statement_timeout=5000 -c lock_timeout=2000"
});
let client: PoolClient;
let statements: string[];
let releases: boolean[];
let failAt: string | undefined;
let failRollback: boolean;
let alterRows: ((rows: any[]) => any[]) | undefined;
let transactionSettings: {readOnly:string; isolation:string} | undefined;
let identifiers: string[];

const reportPool = {
  connect: async () => ({
    query: async (text: string, values?: any[]) => {
      statements.push(text);
      if (failAt && text.startsWith(failAt)) throw new Error("injected query failure");
      if (failRollback && text === "ROLLBACK") throw new Error("injected rollback failure");
      if (text.includes("WITH expected AS")) {
        transactionSettings = {
          readOnly:(await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only,
          isolation:(await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation,
        };
      }
      const result = await client.query(text, values);
      if (alterRows && text.includes("WITH expected AS")) {
        return {...result, rows:alterRows(result.rows)};
      }
      return result;
    },
    release: (discard?: boolean) => { releases.push(discard === true); },
  }),
} as unknown as Pick<Pool, "connect">;

before(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname));
  assert.equal(decodeURIComponent(url.pathname.slice(1)), "host_test");
  const identity = (await pool.query(
    "SELECT current_database() AS name, host(inet_server_addr()) AS address"
  )).rows[0];
  assert.equal(identity.name, "host_test");
  assert.ok(["127.0.0.1", "::1"].includes(identity.address));
});
beforeEach(async () => {
  statements = [];
  releases = [];
  failAt = undefined;
  failRollback = false;
  alterRows = undefined;
  transactionSettings = undefined;
  identifiers = [];
  client = await pool.connect();
  for (const [migration, table] of definitions) {
    const sql = fs.readFileSync("migrations/" + migration, "utf8")
      .replace("CREATE TABLE " + table, () => "CREATE TEMP TABLE " + table);
    await client.query(sql);
  }
});
afterEach(async () => {
  try { await client.query("ROLLBACK"); }
  finally { client.release(true); }
});
after(async () => { await pool.end(); });

async function insert(
  table: string, idColumn: string, operation: string,
  outcome: string, due: boolean, failures = 0
) {
  const id = crypto.randomUUID();
  identifiers.push(id);
  const tokenColumns = table === "cancellation_settlement_queue_reviews" ? "" : ", review_token";
  const tokenValues = tokenColumns ? ", gen_random_uuid()" : "";
  await client.query(`
    INSERT INTO ${table}
      (operation, ${idColumn}, last_reviewed_at, next_review_at,
       review_failures, last_outcome${tokenColumns})
    VALUES ($1, $2, TIMESTAMPTZ '2020-01-01 00:00:00+00',
      $3::timestamptz, $4, $5${tokenValues})
  `, [operation, id, due ? "2020-01-02T00:00:00Z" : "2099-01-01T00:00:00Z", failures, outcome]);
}
async function snapshots() {
  const result: Record<string, unknown> = {};
  for (const [, table, idColumn] of definitions) {
    result[table] = (await client.query(
      `SELECT to_jsonb(q) AS value FROM ${table} q ORDER BY operation, ${idColumn}`
    )).rows;
  }
  return result;
}



import { collectFinancialMonitoring } from "../lib/payments/collectFinancialMonitoring";
import {
  startFinancialRunnerHeartbeat,
  finishFinancialRunnerHeartbeat
} from "../lib/payments/financialRunnerHeartbeatStore";

const policy = {
  maxSnapshotAgeMs: 60000,
  maxHeartbeatAgeMs: 60000,
  operations: Object.fromEntries(financialQueueHealthOperations.map(operation =>
    [operation, {expectedState: "running" as const, dueReviewAgeMs: 1000}]))
};

async function prepareHeartbeat() {
  await client.query(fs.readFileSync(
    "migrations/047_financial_runner_heartbeats.sql", "utf8"
  ).replace("CREATE TABLE financial_runner_heartbeats",
    () => "CREATE TEMP TABLE financial_runner_heartbeats"));
  await client.query("SET search_path=pg_temp,pg_catalog");
  for (const table of [
    ...definitions.map(row => row[1]), "financial_runner_heartbeats"
  ]) {
    assert.equal((await client.query(
      "SELECT relnamespace=pg_my_temp_schema() AS temporary " +
      "FROM pg_class WHERE oid=to_regclass($1)", [table]
    )).rows[0].temporary, true);
  }
}
async function heartbeatSnapshot() {
  return (await client.query(
    "SELECT to_jsonb(h) AS value FROM pg_temp.financial_runner_heartbeats h ORDER BY operation"
  )).rows;
}
function heartbeatDatabase(log: string[]) {
  return {
    query: async (sql: string, values?: any[]) => {
      log.push(sql);
      assert.equal((await client.query(
        "SHOW transaction_read_only"
      )).rows[0].transaction_read_only, "on");
      return client.query(sql, values);
    }
  } as Pick<Pool, "query">;
}
async function collectReadOnly() {
  const heartbeatStatements: string[] = [];
  await client.query("SET default_transaction_read_only=on");
  const result = await collectFinancialMonitoring(
    reportPool, heartbeatDatabase(heartbeatStatements), policy
  );
  assert.deepEqual(transactionSettings,
    {readOnly: "on", isolation: "repeatable read"});
  assert.deepEqual(releases, [false]);
  assert.equal(heartbeatStatements.length, 2);
  assert.equal(heartbeatStatements[1], "SELECT clock_timestamp() AS assessed_at");
  for (const sql of [...statements, ...heartbeatStatements]) {
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP)\b/i);
    assert.doesNotMatch(sql, /FOR\s+(?:UPDATE|SHARE)|advisory.*lock/i);
  }
  return result;
}



import os from "node:os";
import path from "node:path";

let reportMain: typeof import("./reportFinancialMonitoring").main;
let ended = 0;
before(async () => {
  ({main: reportMain} = await import("./reportFinancialMonitoring"));
});

async function invokeReport(selectedPolicy: import("../lib/payments/assessFinancialMonitoring").FinancialMonitoringPolicy = policy) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "HOST-report-fixture-"));
  const file = path.join(directory, "policy.json");
  const savedExitCode = process.exitCode;
  const savedLog = console.log;
  const output: string[] = [];
  const endedBefore = ended;
  try {
    fs.writeFileSync(file, JSON.stringify(selectedPolicy), {flag: "wx"});
    await client.query("SET default_transaction_read_only=on");
    process.exitCode = undefined;
    console.log = (...args: unknown[]) => {output.push(args.map(String).join(" "));};
    let factoryCalls = 0;
    const report = await reportMain([file], options => {
      factoryCalls++;
      assert.equal(options!.max, 1);
      assert.equal(options!.connectionTimeoutMillis, 5000);
      assert.match(options!.options!, /default_transaction_read_only=on/);
      assert.match(options!.options!, /statement_timeout=5000/);
      assert.match(options!.options!, /lock_timeout=2000/);
      return {
        query: async (sql: string, values?: any[]) => {
          assert.equal((await client.query(
            "SHOW transaction_read_only"
          )).rows[0].transaction_read_only, "on");
          return client.query(sql, values);
        },
        connect: () => reportPool.connect(),
        end: async () => {ended++;}
      } as any;
    });
    assert.equal(factoryCalls, 1, "Report must create exactly one fixture pool");
    const code = process.exitCode ?? 0;
    assert.equal(output.length, 1, "Report output capture: " + JSON.stringify({output, report, ended, endedBefore}));
    assert.deepEqual(JSON.parse(output[0]), report);
    assert.equal(ended, endedBefore + 1, "Fixture pool cleanup was not observed");
    return {report, code};
  } finally {
    console.log = savedLog;
    process.exitCode = savedExitCode;
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

async function populateReports() {
  for (const operation of financialQueueHealthOperations) {
    const token = await startFinancialRunnerHeartbeat(client, operation);
    assert.equal(await finishFinancialRunnerHeartbeat(
      client, operation, token, "returned"
    ), true);
  }
}

test("report exit 0: recent returned reports and empty queues", async () => {
  await prepareHeartbeat();
  await populateReports();
  const before = await snapshots(), heartbeatBefore = await heartbeatSnapshot();
  const {report, code} = await invokeReport();
  assert.equal(code, 0);
  assert.ok(report.operations.every(row => row.heartbeat.status === "recent"));
  assert.deepEqual(await snapshots(), before);
  assert.deepEqual(await heartbeatSnapshot(), heartbeatBefore);
});

test("report exit 0: explicitly paused operations with no reports", async () => {
  await prepareHeartbeat();
  const paused = {
    ...policy,
    operations: Object.fromEntries(financialQueueHealthOperations.map(operation =>
      [operation, {expectedState: "paused" as const, dueReviewAgeMs: 1000}]))
  };
  const {report, code} = await invokeReport(paused);
  assert.equal(code, 0);
  assert.ok(report.operations.every(row => row.heartbeat.status === "paused"));
});

for (const scenario of ["missing", "stale", "threw", "queue_due", "schema_missing"] as const) {
  test("report exit 2: " + scenario, async () => {
    await prepareHeartbeat();
    await populateReports();
    const operation = "refund_execute";
    if (scenario === "missing") {
      await client.query("DELETE FROM pg_temp.financial_runner_heartbeats WHERE operation=$1",
        [operation]);
    } else if (scenario === "stale") {
      await client.query(
        "UPDATE pg_temp.financial_runner_heartbeats SET " +
        "started_at=TIMESTAMPTZ '2020-01-01 00:00:00+00', " +
        "reported_at=TIMESTAMPTZ '2020-01-01 00:00:00+00', " +
        "finished_at=TIMESTAMPTZ '2020-01-01 00:00:00+00' WHERE operation=$1",
        [operation]
      );
    } else if (scenario === "threw") {
      const token = await startFinancialRunnerHeartbeat(client, operation);
      await finishFinancialRunnerHeartbeat(client, operation, token, "threw");
    } else if (scenario === "queue_due") {
      await insert("new_flow_refund_queue_reviews", "refund_id", operation, "selected", true);
    } else {
      await client.query("DROP TABLE pg_temp.financial_runner_heartbeats");
    }
    const before = await snapshots();
    const heartbeatBefore = scenario === "schema_missing" ? null : await heartbeatSnapshot();
    const {report, code} = await invokeReport();
    assert.equal(code, 2);
    const row = report.operations.find(value => value.operation === operation)!;
    if (scenario === "missing") assert.equal(row.heartbeat.status, "missing");
    if (scenario === "stale") assert.equal(row.heartbeat.status, "stale");
    if (scenario === "threw") {
      assert.equal(row.heartbeat.status, "recent");
      assert.equal(row.heartbeat.outcome, "threw");
    }
    if (scenario === "queue_due") {
      assert.equal(row.queue.status, "observed");
      if (row.queue.status === "observed") {
        assert.deepEqual(row.queue.assessment.observations, [
          "selected_metadata_without_feedback", "due_metadata_requires_review"
        ]);
      }
    }
    if (scenario === "schema_missing") {
      assert.deepEqual(report.heartbeat,
        {status: "unavailable", reason: "schema_unavailable"});
    }
    assert.deepEqual(await snapshots(), before);
    if (heartbeatBefore !== null) {
      assert.deepEqual(await heartbeatSnapshot(), heartbeatBefore);
    }
  });
}
