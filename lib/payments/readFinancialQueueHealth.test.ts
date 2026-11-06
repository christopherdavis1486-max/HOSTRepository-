import { test, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { Pool, type PoolClient } from "pg";
import {
  readFinancialQueueHealth,
  financialQueueHealthOperations,
} from "./readFinancialQueueHealth";

const definitions = [
  ["042_cancellation_settlement_queue_reviews.sql", "cancellation_settlement_queue_reviews", "settlement_id", ["settlement_execute", "settlement_reconcile"]],
  ["043_new_flow_payment_queue_reviews.sql", "new_flow_payment_queue_reviews", "payment_attempt_id", ["payment_reconcile", "missing_refund_recover"]],
  ["044_new_flow_refund_queue_reviews.sql", "new_flow_refund_queue_reviews", "refund_id", ["refund_execute", "refund_reconcile"]],
  ["045_host_transfer_queue_reviews.sql", "host_transfer_queue_reviews", "entitlement_id", ["transfer_execute", "transfer_reconcile"]],
  ["046_transfer_reversal_queue_reviews.sql", "transfer_reversal_queue_reviews", "reversal_id", ["reversal_execute", "reversal_reconcile"]],
] as const;
const pool = new Pool({connectionString:process.env.DATABASE_URL, max:2});
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

test("empty metadata returns all ten operations with zeros and null timestamps", async () => {
  const report = await readFinancialQueueHealth(reportPool);
  assert.equal(report.scope, "scheduling_metadata_only");
  assert.equal(report.rows.length, 10);
  assert.deepEqual(report.rows.map(row => row.operation), [...financialQueueHealthOperations].sort());
  for (const row of report.rows) {
    for (const field of [
      "total", "due", "cooling", "selectedAwaitingFeedback", "selectedDue",
      "unresolved", "backingOff", "resolved", "eligible",
    ] as const) assert.equal(row[field], "0");
    assert.equal(row.maxReviewFailures, 0);
    assert.equal(row.oldestDueAt, null);
    assert.equal(row.oldestReviewedAt, null);
  }
  assert.ok(Number.isFinite(Date.parse(report.observedAt)));
});

for (const [, table, idColumn, operations] of definitions) {
  for (const operation of operations) {
    test("real metadata counts and cooldown categories: " + operation, async () => {
      const settlement = operation.startsWith("settlement_");
      if (settlement) {
        await insert(table, idColumn, operation, "eligible", true);
        await insert(table, idColumn, operation, "eligible", false);
        await insert(table, idColumn, operation, "review_required", true, 2);
        await insert(table, idColumn, operation, "review_required", false, 16);
      } else {
        await insert(table, idColumn, operation, "selected", true);
        await insert(table, idColumn, operation, "selected", false);
        await insert(table, idColumn, operation, "unresolved", true, 2);
        await insert(table, idColumn, operation, "unresolved", false, 16);
        await insert(table, idColumn, operation, "resolved", false);
      }
      const before = await snapshots();
      const report = await readFinancialQueueHealth(reportPool);
      assert.deepEqual(await snapshots(), before);
      const row = report.rows.find(row => row.operation === operation)!;
      assert.equal(row.total, settlement ? "4" : "5");
      assert.equal(row.due, "2");
      assert.equal(row.cooling, settlement ? "2" : "3");
      assert.equal(row.selectedAwaitingFeedback, settlement ? "0" : "2");
      assert.equal(row.selectedDue, settlement ? "0" : "1");
      assert.equal(row.unresolved, "2");
      assert.equal(row.backingOff, "1");
      assert.equal(row.resolved, settlement ? "0" : "1");
      assert.equal(row.eligible, settlement ? "2" : "0");
      assert.equal(row.maxReviewFailures, 16);
      assert.equal(row.oldestDueAt, "2020-01-02T00:00:00.000Z");
      assert.equal(row.oldestReviewedAt, "2020-01-01T00:00:00.000Z");
      for (const other of report.rows.filter(value => value.operation !== operation)) {
        assert.equal(other.total, "0");
      }
      const serialized = JSON.stringify(report);
      for (const id of identifiers) assert.equal(serialized.includes(id), false);
    });
  }
}

test("report runs read-only at repeatable-read isolation and releases its connection", async () => {
  await readFinancialQueueHealth(reportPool);
  assert.deepEqual(transactionSettings, {readOnly:"on", isolation:"repeatable read"});
  assert.equal(statements[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(statements.at(-1), "COMMIT");
  assert.deepEqual(releases, [false]);
  assert.ok(statements.includes("SET LOCAL lock_timeout = '2s'"));
  assert.ok(statements.includes("SET LOCAL statement_timeout = '5s'"));
});

test("query failure rolls back instead of returning healthy empty queues", async () => {
  failAt = "\n  WITH expected";
  await assert.rejects(readFinancialQueueHealth(reportPool), /injected query failure/);
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.deepEqual(releases, [false]);
  assert.equal((await client.query("SELECT 1 AS value")).rows[0].value, 1);
});

test("rollback failure discards the connection and preserves the original error", async () => {
  failAt = "\n  WITH expected";
  failRollback = true;
  await assert.rejects(readFinancialQueueHealth(reportPool), /injected query failure/);
  assert.deepEqual(releases, [true]);
});

test("begin failure discards the connection", async () => {
  failAt = "BEGIN";
  await assert.rejects(readFinancialQueueHealth(reportPool), /injected query failure/);
  assert.deepEqual(releases, [true]);
});

for (const [name, change] of [
  ["missing operation", (rows: any[]) => rows.slice(1)],
  ["duplicate operation", (rows: any[]) => [rows[0], rows[0], ...rows.slice(2)]],
  ["unknown operation", (rows: any[]) => [{...rows[0], operation:"unknown"}, ...rows.slice(1)]],
  ["numeric count", (rows: any[]) => [{...rows[0], total:0}, ...rows.slice(1)]],
  ["negative count", (rows: any[]) => [{...rows[0], due:"-1"}, ...rows.slice(1)]],
  ["invalid failure count", (rows: any[]) => [{...rows[0], max_review_failures:17}, ...rows.slice(1)]],
  ["invalid timestamp", (rows: any[]) => [{...rows[0], observed_at:new Date(NaN)}, ...rows.slice(1)]],
  ["mixed snapshot timestamps", (rows: any[]) => [{...rows[0], observed_at:new Date("2000-01-01")}, ...rows.slice(1)]],
] as const) {
  test("malformed results fail visibly: " + name, async () => {
    alterRows = change;
    await assert.rejects(readFinancialQueueHealth(reportPool), /queue health/i);
    assert.equal(statements.at(-1), "ROLLBACK");
    assert.deepEqual(releases, [false]);
  });
}

test("bigint count strings retain precision beyond JavaScript safe integers", async () => {
  alterRows = rows => [{
    ...rows[0], total:"9007199254740993", due:"9007199254740993", cooling:"0",
  }, ...rows.slice(1)];
  const report = await readFinancialQueueHealth(reportPool);
  assert.equal(report.rows[0].total, "9007199254740993");
  assert.equal(report.rows[0].due, "9007199254740993");
});

test("report does not issue financial writes, row locks or advisory locks", async () => {
  await readFinancialQueueHealth(reportPool);
  for (const sql of statements) {
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP)\b/i);
    assert.doesNotMatch(sql, /FOR\s+(?:UPDATE|SHARE)|advisory.*lock/i);
  }
});

test("database report integrates with pure monitoring assessment without metadata changes", async () => {
  const {assessFinancialQueueHealth} = await import("./assessFinancialQueueHealth");
  await insert(
    "new_flow_refund_queue_reviews", "refund_id", "refund_execute", "selected", true
  );
  const before = await snapshots();
  const report = await readFinancialQueueHealth(reportPool);
  const assessment = assessFinancialQueueHealth(report, {
    maxSnapshotAgeMs:60000,
    operations:{refund_execute:{expectedState:"running", dueReviewAgeMs:1000}},
  });
  assert.equal(assessment.status, "observed");
  const row = assessment.operations.find(row => row.operation === "refund_execute")!;
  assert.deepEqual(row.observations, [
    "selected_metadata_without_feedback", "due_metadata_requires_review",
  ]);
  assert.deepEqual(await snapshots(), before);
});
