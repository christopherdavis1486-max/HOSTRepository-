
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { performance } = require("node:perf_hooks");

const output = "docs/reversal-selector-profile-2026-10-21.json";
const tables = [
  "host_profiles", "host_transfer_reversals",
  "bookings", "payment_attempts", "booking_price_components", "audit_log",
  "new_flow_refunds", "host_transfer_entitlements",
  "cancellation_host_settlements", "payments", "refunds", "payouts",
  "transfer_reversal_queue_reviews",
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
    scope: "synthetic_reversal_selection_only",
    scales: [0, 100, 1000],
    fixtureLimitations: [
      "Temporary tables retain local column types and indexes, but constraints and defaults are not reproduced.",
      "Unused columns are null; row widths and distributions do not reproduce production.",
      "Warm local single-session measurements; no concurrent load or production capacity claim.",
      "Selection SQL only; no queue writes, advisory locking, claims, dispatch or provider operations.",
      "Settlement selectors remain outside this profile; larger reversal scales and concurrency remain unmeasured."
    ],
    sourceScriptSha256: "9ad1a939d34c01acd91863eb8aa5cc992c301a5f9f860a50f57448ec6d7aef04",
    fixtureDescription: "Real reversal financial eligibility; 50 percent paid guest cancellations; mixed policy-amount mismatches and legacy-refund blockers; queue ordering checks never-reviewed rows first",
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
    const { buildTransferReversalSelectionQuery: build } =
      require("../lib/payouts/selectTransferReversalJobs.ts");
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
      for (const operation of ["reversal_execute", "reversal_reconcile"]) {
        for (const distribution of ["eligible", "mixed", "cooling"]) {
          for (const table of [...tables, "fixture_seed"]) {
            await client.query("TRUNCATE pg_temp." + quote(table));
          }
          await client.query(
            "INSERT INTO fixture_seed SELECT i, md5(i::text)::uuid FROM generate_series(1, $1::int) i",
            [count]
          );

          await client.query(
            "INSERT INTO host_profiles (id,stripe_connect_account_id,payout_account_status) " +
            "SELECT id,'acct_reversal_' || i::text,'active' FROM fixture_seed"
          );
          await client.query(
            "INSERT INTO bookings (id,host_id,status,payment_flow_version) " +
            "SELECT id,id,'cancelled','separate_charges_delayed_v1' FROM fixture_seed"
          );
          await client.query(
            "INSERT INTO payment_attempts " +
            "(id,booking_id,attempt_number,status,provider_payment_intent_id,amount_minor,currency) " +
            "SELECT id,id,1,'succeeded','pi_reversal_' || i::text,24000,'GBP' FROM fixture_seed"
          );
          await client.query(
            "INSERT INTO booking_price_components " +
            "(id,booking_id,guest_total_minor,host_payout_minor,currency) " +
            "SELECT id,id,24000,20000,'GBP' FROM fixture_seed"
          );
          await client.query(
            "INSERT INTO host_transfer_entitlements " +
            "(id,booking_id,host_id,status,amount_minor,currency,provider_transfer_id) " +
            "SELECT id,id,id,'transfer_created',20000,'GBP','tr_reversal_' || i::text FROM fixture_seed"
          );
          await client.query(
            "INSERT INTO new_flow_refunds " +
            "(id,booking_id,payment_attempt_id,amount_minor,currency,reason,initiated_by,status) " +
            "SELECT id,id,id,12000,'GBP','guest_cancellation','guest','pending' FROM fixture_seed"
          );
          await client.query(
            "INSERT INTO host_transfer_reversals " +
            "(id,entitlement_id,amount_minor,reason,status,idempotency_key,requested_at," +
            "execution_token,execution_started_at) " +
            "SELECT id,id,CASE WHEN $2::boolean AND i % 10 >= 8 THEN 10001 ELSE 10000 END," +
            "'refund',$1,'reversal-profile-' || i::text," +
            "TIMESTAMPTZ '2000-01-01' + i * INTERVAL '1 second'," +
            "CASE WHEN $3::boolean THEN id ELSE NULL::uuid END," +
            "CASE WHEN $3::boolean THEN TIMESTAMPTZ '1999-01-01' ELSE NULL::timestamptz END " +
            "FROM fixture_seed",
            [operation === "reversal_execute" ? "reversal_requested" : "reversal_reconciliation_required",
             distribution === "mixed",operation === "reversal_reconcile"]
          );
          await client.query(
            "INSERT INTO audit_log (id,object_id,object_type,action,previous_state,new_state) " +
            "SELECT id,id,'booking','booking_cancelled'," +
            "'{\"status\":\"confirmed\"}'::jsonb," +
            "jsonb_build_object('status','cancelled','cancelledBy','guest','cancellationKind','paid'," +
            "'paymentFlowVersion','separate_charges_delayed_v1'," +
            "'refundPercent',50,'refundableMinor',12000,'hostRetainedMinor',10000," +
            "'refundId',id::text,'reversalId',id::text,'entitlementId',id::text," +
            "'settlementId',NULL,'retainedPayoutSettlementRequired',false) FROM fixture_seed"
          );
          if (distribution === "mixed") {
            await client.query(
              "INSERT INTO refunds (id,booking_id) SELECT id,id FROM fixture_seed WHERE i % 10 = 7"
            );
          }
          await client.query(
            "INSERT INTO transfer_reversal_queue_reviews " +
            "(operation,reversal_id,review_token,last_reviewed_at,next_review_at,review_failures,last_outcome) " +
            "SELECT $1,id,id,TIMESTAMPTZ '1999-01-01'," +
            "CASE WHEN $2::boolean AND i % 3 = 0 THEN TIMESTAMPTZ '2100-01-01' " +
            "ELSE TIMESTAMPTZ '2000-01-01' END,0,'selected' " +
            "FROM fixture_seed WHERE i % 3 <> 2",
            [operation,distribution !== "eligible"]
          );
          for (const table of tables) {
            await client.query("ANALYZE pg_temp." + quote(table));
          }

          for (const useQueue of [false, true]) {

            const candidates=[];
            for (let i=1;i<=count;i++) {
              if (distribution === "mixed" && (i % 10 >= 8 || i % 10 === 7)) continue;
              if (useQueue && distribution !== "eligible" && i % 3 === 0) continue;
              candidates.push(i);
            }
            if (useQueue) candidates.sort((a,b) =>
              Number(a % 3 !== 2)-Number(b % 3 !== 2) || a-b);
            const expected=candidates.slice(0,25).map(id);
            const query = build(operation, 25, useQueue);
            assert.match(query.text.trim(), /^(SELECT|WITH)\b/i);
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
  console.error("Reversal selector profile failed:", error.message);
  process.exitCode = 1;
});
