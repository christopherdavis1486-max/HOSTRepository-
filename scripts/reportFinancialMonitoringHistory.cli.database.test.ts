import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";
import {Pool, type PoolClient} from "pg";
import {financialQueueHealthOperations as operations}
  from "../lib/payments/readFinancialQueueHealth";
import {loadFinancialMonitoringAlertHistory as load}
  from "../lib/payments/financialMonitoringAlertHistoryFile";

test("full CLI: isolated database history survives processes and clears on recent reports", async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost","127.0.0.1","[::1]","::1"].includes(url.hostname));
  assert.equal(decodeURIComponent(url.pathname.slice(1)), "host_test");
  const schema = "host_history_cli_" + crypto.randomBytes(8).toString("hex");
  assert.match(schema, /^host_history_cli_[a-f0-9]{16}$/);
  const pool = new Pool({
    connectionString: url.toString(), max: 1, connectionTimeoutMillis: 5000,
    options: "-c statement_timeout=5000 -c lock_timeout=2000"
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "host-cli-database-"));
  let created = false;
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const identity = (await client.query(
      "SELECT current_database() AS name, host(inet_server_addr()) AS address"
    )).rows[0];
    assert.equal(identity.name, "host_test");
    assert.ok(["127.0.0.1","::1"].includes(identity.address));
    await client.query('CREATE SCHEMA "' + schema + '"');
    created = true;
    await client.query("SELECT set_config('search_path',$1,false)",
      [schema + ",pg_catalog"]);

    const migrations = [
      "042_cancellation_settlement_queue_reviews.sql",
      "043_new_flow_payment_queue_reviews.sql",
      "044_new_flow_refund_queue_reviews.sql",
      "045_host_transfer_queue_reviews.sql",
      "046_transfer_reversal_queue_reviews.sql",
      "047_financial_runner_heartbeats.sql"
    ];
    for (const migration of migrations) {
      await client.query(fs.readFileSync("migrations/" + migration, "utf8"));
    }
    const tables = (await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename",
      [schema]
    )).rows;
    assert.equal(tables.length, 6);

    const policyFile = path.join(directory, "policy.json");
    function policy(paused: boolean) {
      fs.writeFileSync(policyFile, JSON.stringify({
        maxSnapshotAgeMs: 60000, maxHeartbeatAgeMs: 60000,
        operations: Object.fromEntries(operations.map(operation => [
          operation, {
            expectedState: paused ? "paused" : "running",
            dueReviewAgeMs: 30000
          }
        ]))
      }));
    }
    const childUrl = new URL(url.toString());
    childUrl.searchParams.set("options",
      "-c search_path=" + schema + ",pg_catalog" +
      " -c default_transaction_read_only=on" +
      " -c statement_timeout=5000 -c lock_timeout=2000");
    function invoke(previous: string, name: string, expectedCode: number) {
      const next = path.join(directory, name);
      const result = spawnSync(process.execPath, [
        "--import","tsx","scripts/reportFinancialMonitoringHistory.ts",
        policyFile, previous, next
      ], {
        encoding:"utf8", timeout:20000, maxBuffer:4*1024*1024,
        env:{...process.env,DATABASE_URL:childUrl.toString()}
      });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, expectedCode, result.stderr);
      assert.equal(result.stderr, "");
      const report = JSON.parse(result.stdout);
      assert.deepEqual(load(next), {
        ...report.state,
        pending: report.state.pending.map((entry: any) => ({
          ...entry,
          evidence: [...entry.evidence.slice(0,3), new Date(entry.evidence[3])]
        }))
      });
      return {next, report};
    }

    policy(true);
    const paused = invoke("-", "paused.json", 0);
    assert.equal(paused.report.state.pending.length, 0);

    policy(false);
    const missing = invoke(paused.next, "missing.json", 2);
    assert.equal(missing.report.state.pending.length, 10);
    assert.ok(missing.report.current.assessment.operations.every(
      (row: any) => row.heartbeat.status === "missing"));
    const missingBytes = fs.readFileSync(missing.next);

    await client.query("DROP TABLE financial_runner_heartbeats");
    const unavailable = invoke(missing.next, "unavailable.json", 2);
    assert.equal(unavailable.report.state.pending.length, 11);
    assert.deepEqual(unavailable.report.current.assessment.heartbeat,
      {status:"unavailable",reason:"schema_unavailable"});
    assert.equal(unavailable.report.transitions.filter(
      (row: any) => row.finding.code === "heartbeat_missing" &&
        row.status === "unconfirmed").length, 10);
    assert.ok(fs.readFileSync(missing.next).equals(missingBytes));
    const unavailableBytes = fs.readFileSync(unavailable.next);

    await client.query(fs.readFileSync(
      "migrations/047_financial_runner_heartbeats.sql","utf8"));
    for (const operation of operations) {
      await client.query(
        "INSERT INTO financial_runner_heartbeats " +
        "(operation,run_token,started_at,reported_at,finished_at,outcome) " +
        "SELECT $1,$2::uuid,at,at,at,'returned' " +
        "FROM (SELECT clock_timestamp() AS at) stamp",
        [operation,crypto.randomUUID()]
      );
    }
    const recovered = invoke(unavailable.next, "recovered.json", 0);
    assert.equal(recovered.report.state.pending.length, 0);
    assert.equal(recovered.report.transitions.length, 11);
    assert.ok(recovered.report.transitions.every(
      (row: any) => row.status === "cleared"));
    assert.ok(fs.readFileSync(missing.next).equals(missingBytes));
    assert.ok(fs.readFileSync(unavailable.next).equals(unavailableBytes));
    assert.equal((await client.query(
      "SELECT count(*)::int AS count FROM financial_runner_heartbeats"
    )).rows[0].count, 10);
  } finally {
    try {
      if (client && created) {
        await client.query("SET search_path=pg_catalog");
        await client.query('DROP SCHEMA "' + schema + '" CASCADE');
        assert.equal((await client.query(
          "SELECT count(*)::int AS count FROM pg_namespace WHERE nspname=$1",
          [schema]
        )).rows[0].count, 0);
        console.log("Removed disposable CLI fixture schema: " + schema);
      }
    } finally {
      if (client) client.release(true);
      await pool.end();
      fs.rmSync(directory, {recursive:true,force:true});
    }
  }
});
