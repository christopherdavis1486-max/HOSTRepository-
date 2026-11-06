
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { performance } = require("node:perf_hooks");

const output = "docs/financial-refund-selector-profile-2026-10-21.json";
const tables = [
  "bookings", "payment_attempts", "booking_price_components", "audit_log",
  "new_flow_refunds", "host_transfer_entitlements",
  "cancellation_host_settlements", "payments", "refunds", "payouts",
  "new_flow_refund_queue_reviews",
];
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const id = value => {
  const hex = crypto.createHash("md5").update(String(value)).digest("hex");
  return hex.slice(0,8)+"-"+hex.slice(8,12)+"-"+hex.slice(12,16)+"-"+hex.slice(16,20)+"-"+hex.slice(20);
};

async function main() {
  assert.ok(!fs.existsSync(output), "Profile evidence already exists; do not overwrite.");
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname));
  assert.equal(decodeURIComponent(url.pathname.slice(1)), "host_test");

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1, connectionTimeoutMillis: 5000,
  });
  let applicationDb;
  const client = await pool.connect();
  const evidence = {
    observedAt: new Date().toISOString(),
    scope: "synthetic_refund_selection_only",
    scales: [0, 1000, 10000],
    fixtureLimitations: [
      "Temporary tables retain local column types and indexes, but constraints and defaults are not reproduced.",
      "Unused columns are null; row widths and distributions do not reproduce production.",
      "Warm local single-session measurements; no concurrent load or production capacity claim.",
      "Selection SQL only; no queue writes, advisory locking, claims, dispatch or provider operations.",
      "Transfer, reversal and settlement selectors remain outside this profile."
    ],
    sourceScriptSha256: "9ad1a939d34c01acd91863eb8aa5cc992c301a5f9f860a50f57448ec6d7aef04",
    fixtureDescription: "Mixed refunds exceed their payment amount for i % 10 >= 8; queue cooldown excludes i % 3 = 0; other stored metadata is due or absent",
    indexes: [], cases: [],
  };
  try {
    const identity = (await client.query(
      "SELECT current_database() AS name, host(inet_server_addr()) AS address, version() AS version"
    )).rows[0];
    assert.equal(identity.name, "host_test");
    assert.ok(["127.0.0.1", "::1"].includes(identity.address));
    evidence.databaseVersion = identity.version;

    // Builders import the application pool but do not issue queries.
    const { buildNewFlowRefundSelectionQuery: build } =
      require("../lib/payments/selectNewFlowRefundJobs.ts");
    applicationDb = require("../lib/db/index.ts").db;

    await client.query("SET statement_timeout = '15s'");
    await client.query("SET lock_timeout = '2s'");
    for (const table of tables) {
      const indexes = (await client.query(
        "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 ORDER BY indexname",
        [table]
      )).rows;
      evidence.indexes.push({ table, indexes });
      await client.query(
        "CREATE TEMP TABLE " + quote(table) +
        " (LIKE public." + quote(table) + " INCLUDING INDEXES)"
      );
      const columns = (await client.query(
        "SELECT attname FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped AND attnotnull AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = attrelid AND c.contype = 'p' AND attnum = ANY(c.conkey))",
        ["pg_temp." + table]
      )).rows;
      for (const column of columns) {
        await client.query(
          "ALTER TABLE pg_temp." + quote(table) +
          " ALTER COLUMN " + quote(column.attname) + " DROP NOT NULL"
        );
      }
    }
    await client.query("SET search_path = pg_temp, pg_catalog");
    for (const table of tables) {
      const check = (await client.query(
        "SELECT relpersistence, relnamespace = pg_my_temp_schema() AS isolated FROM pg_class WHERE oid = $1::regclass",
        [table]
      )).rows[0];
      assert.equal(check.relpersistence, "t");
      assert.equal(check.isolated, true);
    }
    await client.query("CREATE TEMP TABLE fixture_seed (i integer PRIMARY KEY, id uuid)");

    for (const count of evidence.scales) {
      for (const operation of ["refund_execute", "refund_reconcile"]) {
        for (const distribution of ["eligible", "mixed", "cooling"]) {
          for (const table of [...tables, "fixture_seed"]) {
            await client.query("TRUNCATE pg_temp." + quote(table));
          }
          await client.query(
            "INSERT INTO fixture_seed SELECT i, md5(i::text)::uuid FROM generate_series(1, $1::int) i",
            [count]
          );

          await client.query(
            "INSERT INTO bookings (id,status,payment_flow_version) " +
            "SELECT id,'cancelled','separate_charges_delayed_v1' FROM fixture_seed"
          );
          await client.query(
            "INSERT INTO payment_attempts (id,booking_id,attempt_number,status,provider_payment_intent_id,amount_minor,currency) " +
            "SELECT id,id,1,'succeeded','pi_refund_profile',25500,'GBP' FROM fixture_seed"
          );
          await client.query(
            "INSERT INTO new_flow_refunds " +
            "(id,booking_id,payment_attempt_id,status,reconciliation_required,claim_token," +
            "execution_started_at,amount_minor,currency,created_at,updated_at) " +
            "SELECT id,id,id,$1,$2::boolean," +
            "CASE WHEN $2::boolean THEN id ELSE NULL::uuid END," +
            "CASE WHEN $2::boolean THEN TIMESTAMPTZ '1999-01-01' ELSE NULL::timestamptz END," +
            "CASE WHEN $3::boolean AND i % 10 >= 8 THEN 30000 ELSE 10000 END," +
            "'GBP',TIMESTAMPTZ '2000-01-01' + i * INTERVAL '1 second'," +
            "TIMESTAMPTZ '2000-01-01' + i * INTERVAL '1 second' FROM fixture_seed",
            [operation === "refund_execute" ? "pending" : "processing",
             operation === "refund_reconcile", distribution === "mixed"]
          );
          await client.query(
            "INSERT INTO new_flow_refund_queue_reviews " +
            "(operation,refund_id,review_token,last_reviewed_at,next_review_at,review_failures,last_outcome) " +
            "SELECT $1,id,id,TIMESTAMPTZ '1999-01-01'," +
            "CASE WHEN $2::boolean AND i % 3 = 0 THEN TIMESTAMPTZ '2100-01-01' " +
            "ELSE TIMESTAMPTZ '2000-01-01' + i * INTERVAL '1 second' END,0,'selected' " +
            "FROM fixture_seed WHERE i % 3 <> 2",
            [operation,distribution !== "eligible"]
          );
          for (const table of tables) {
            await client.query("ANALYZE pg_temp." + quote(table));
          }

          for (const useQueue of [false, true]) {
            const expected = [];
            for (let i = 1; i <= count && expected.length < 25; i++) {
              if (distribution === "mixed" && i % 10 >= 8) continue;
              if (useQueue && distribution !== "eligible" && i % 3 === 0) continue;
              expected.push(id(i));
            }
            const query = build(operation, 25, useQueue);
            assert.match(query.text.trim(), /^SELECT\b/i);
            await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
            try {
              const checked = async () => {
                const rows = (await client.query(query.text, query.values)).rows;
                assert.deepEqual(rows.map(row => row.id), expected);
              };
              await checked();
              const samples = [];
              for (let repeat = 0; repeat < 3; repeat++) {
                const start = performance.now();
                await checked();
                samples.push(performance.now() - start);
              }
              const plan = (await client.query(
                "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + query.text, query.values
              )).rows[0]["QUERY PLAN"][0];
              await client.query("COMMIT");
              const median = [...samples].sort((a,b) => a-b)[1];
              evidence.cases.push({
                count, operation, distribution, useQueue,
                selected: expected.length, assertions: "exact IDs and order passed",
                samplesMs: samples, medianMs: median,
                sqlSha256: crypto.createHash("sha256").update(query.text).digest("hex"),
                plan,
              });
              console.log(JSON.stringify({
                count, operation, distribution, useQueue,
                selected: expected.length, medianMs: Number(median.toFixed(3)),
                explainExecutionMs: plan["Execution Time"],
              }));
            } catch (error) {
              await client.query("ROLLBACK");
              throw error;
            }
          }
        }
      }
    }
    assert.equal(evidence.cases.length, 36);
    fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
    console.log("PROFILE VERIFIED: 36 cases; exact IDs/order passed in every warmup and timed query.");
    console.log("Saved " + output);
  } finally {
    client.release(true);
    await pool.end();
    if (applicationDb) await applicationDb.end();
  }
}
main().catch(error => {
  console.error("Refund selector profile failed:", error.message);
  process.exitCode = 1;
});
