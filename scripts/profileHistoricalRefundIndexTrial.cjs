
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { performance } = require("node:perf_hooks");

const output = "docs/historical-refund-index-trial-2026-10-21.json";
const tables = [
  "bookings", "payment_attempts", "booking_price_components", "audit_log",
  "new_flow_refunds", "host_transfer_entitlements",
  "cancellation_host_settlements", "payments", "refunds", "payouts",
  "new_flow_payment_queue_reviews",
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
    scope: "synthetic_historical_refund_temporary_index_trial",
    scales: [1000, 10000],
    fixtureLimitations: [
      "Temporary tables retain local column types and indexes, but constraints and defaults are not reproduced.",
      "Unused columns are null; row widths and distributions do not reproduce production.",
      "Warm local single-session measurements; no concurrent load or production capacity claim.",
      "Selection SQL only; no queue writes, advisory locking, claims, dispatch or provider operations.",
      "Other financial selectors remain unprofiled."
    ],
    trialIndex: "Temporary nonunique btree refunds(booking_id); removed for baseline_after",
    sourceScriptSha256: "9ad1a939d34c01acd91863eb8aa5cc992c301a5f9f860a50f57448ec6d7aef04",
    comparisonLimitations: "Fixed variant order; warm synthetic fixtures; index build cost excluded; no production capacity or write-cost conclusion",
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
    const { buildNewFlowPaymentSelectionQuery: build } =
      require("../lib/payments/selectNewFlowPaymentJobs.ts");
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
      for (const operation of ["missing_refund_recover"]) {
        for (const distribution of ["mixed"]) {
          for (const table of [...tables, "fixture_seed"]) {
            await client.query("TRUNCATE pg_temp." + quote(table));
          }
          await client.query(
            "INSERT INTO fixture_seed SELECT i, md5(i::text)::uuid FROM generate_series(1, $1::int) i",
            [count]
          );
          await client.query(
            "INSERT INTO bookings (id,status,payment_flow_version,stripe_customer_id,hold_expires_at) " +
            "SELECT id,$1,'separate_charges_delayed_v1','cus_profile',TIMESTAMPTZ '2000-01-01' FROM fixture_seed",
            [operation === "payment_reconcile" ? "pending_payment" : "cancelled"]
          );
          await client.query(
            "INSERT INTO payment_attempts (id,booking_id,attempt_number,status,provider_payment_intent_id,amount_minor,currency,updated_at) " +
            "SELECT id,id,1,$1,'pi_profile',25500,'GBP',TIMESTAMPTZ '2000-01-01' + i * INTERVAL '1 second' FROM fixture_seed",
            [operation === "payment_reconcile" ? "processing" : "succeeded"]
          );
          await client.query(
            "INSERT INTO booking_price_components (id,booking_id,guest_total_minor,currency) " +
            "SELECT id,id,CASE WHEN $1::boolean AND i % 10 >= 8 THEN 1 ELSE 25500 END,'GBP' FROM fixture_seed",
            [distribution === "mixed"]
          );
          if (operation === "missing_refund_recover") {
            await client.query(
              "INSERT INTO audit_log (id,object_id,object_type,action,previous_state,new_state) " +
              "SELECT id,id,'booking','booking_hold_expired'," +
              "'{\"status\":\"pending_payment\"}'::jsonb," +
              "jsonb_build_object('status','cancelled','cancelledBy','system','reason','payment_hold_expired'," +
              "'holdExpiresAt','2000-01-01T00:00:00.000Z') FROM fixture_seed"
            );
          }
          if (distribution === "mixed") {
            await client.query(
              "INSERT INTO refunds (id,booking_id) SELECT id,id FROM fixture_seed WHERE i % 10 = 7"
            );
          }
          await client.query(
            "INSERT INTO new_flow_payment_queue_reviews " +
            "(operation,payment_attempt_id,review_token,last_reviewed_at,next_review_at,review_failures,last_outcome) " +
            "SELECT $1,id,id,TIMESTAMPTZ '1999-01-01'," +
            "CASE WHEN $2::boolean AND i % 3 = 0 THEN TIMESTAMPTZ '2100-01-01' " +
            "ELSE TIMESTAMPTZ '2000-01-01' + i * INTERVAL '1 second' END,0,'selected' " +
            "FROM fixture_seed WHERE i % 3 <> 2",
            [operation, distribution !== "eligible"]
          );
          for (const table of tables) {
            await client.query("ANALYZE pg_temp." + quote(table));
          }

          for (const useQueue of [false, true])
          for (const variant of ["baseline_before", "temporary_index", "baseline_after"]) {
            await client.query("DROP INDEX IF EXISTS pg_temp.host_trial_refunds_booking");
            if (variant === "temporary_index") {
              await client.query(
                "CREATE INDEX host_trial_refunds_booking ON pg_temp.refunds (booking_id)"
              );
            }
            await client.query("ANALYZE pg_temp.refunds");
            const trialIndex = (await client.query(
              "SELECT count(*)::int AS count FROM pg_class WHERE relnamespace = pg_my_temp_schema() AND relname = 'host_trial_refunds_booking'"
            )).rows[0].count;
            assert.equal(trialIndex, variant === "temporary_index" ? 1 : 0);
            const expected = [];
            for (let i = 1; i <= count && expected.length < 25; i++) {
              if (distribution === "mixed" && i % 10 >= 8) continue;
              if (distribution === "mixed" && operation === "missing_refund_recover" && i % 10 === 7) continue;
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
                count, operation, distribution, useQueue, variant,
                selected: expected.length, assertions: "exact IDs and order passed",
                samplesMs: samples, medianMs: median,
                sqlSha256: crypto.createHash("sha256").update(query.text).digest("hex"),
                plan,
              });
              console.log(JSON.stringify({
                count, operation, distribution, useQueue, variant,
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
    assert.equal(evidence.cases.length, 12);
    fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
    console.log("TRIAL VERIFIED: 12 cases; exact IDs/order passed before, with and after the temporary index.");
    console.log("Saved " + output);
  } finally {
    client.release(true);
    await pool.end();
    if (applicationDb) await applicationDb.end();
  }
}
main().catch(error => {
  console.error("Historical refund temporary-index trial failed:", error.message);
  process.exitCode = 1;
});
