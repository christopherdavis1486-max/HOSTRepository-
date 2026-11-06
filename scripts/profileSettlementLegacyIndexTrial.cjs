
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { performance } = require("node:perf_hooks");

const output = "docs/settlement-legacy-index-trial-2026-10-21.json";
const tables = [
  "host_profiles", "host_transfer_reversals",
  "bookings", "payment_attempts", "booking_price_components", "audit_log",
  "new_flow_refunds", "host_transfer_entitlements",
  "cancellation_host_settlements", "payments", "refunds", "payouts",
  "cancellation_settlement_queue_reviews",
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
    scope: "synthetic_settlement_legacy_temporary_index_trial",
    scales: [1000, 10000],
    fixtureLimitations: [
      "Temporary tables retain local column types and indexes, but constraints and defaults are not reproduced.",
      "Unused columns are null; row widths and distributions do not reproduce production.",
      "Warm local single-session measurements; no concurrent load or production capacity claim.",
      "Extracted unchanged discovery SQL plus real advisory eligibility helper; no queue writes, locking, claims, dispatch or provider operations.",
      "Queue review writes, advisory locking, concurrent changes and larger scales remain unmeasured."
    ],
    sourceScriptSha256: "34334d25d36ed4c01c9b3694339a4ad85d2635ce5f87d13ed00a108eb7f381d7",
    fixtureDescription: "Real settlement eligibility; 50 percent paid cancellations with verified refunds; mixed retained-amount mismatches and pending refunds; bounded candidate window before eligibility filtering",
    experimentDescription: "1000/10000 bookings under one host; count unrelated rows in each legacy table and reversal table; original mixed eligibility blockers retained",
    trialLimitations: [
      "Fixed variant order and warm synthetic fixtures; not a randomized causal estimate.",
      "Index build time is excluded; persistent write, storage, locking and durability costs remain unmeasured.",
      "Refunds-only and payouts-only variants isolate index presence within this fixture.",
      "Both trial indexes are removed for baseline_after; no persistent indexes or application changes."
    ],
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
    const { isCancellationSettlementCandidateEligible: eligible } =
      require("../lib/payouts/selectCancellationSettlementJobs.ts");
    const selectorFiles = [
      "lib/payouts/selectCancellationSettlementJobs.ts",
      "lib/payouts/reviewCancellationSettlementQueue.ts",
      "lib/payouts/cancellationSettlementEligibility.ts"
    ];
    evidence.implementationHashes = selectorFiles.map(file => ({
      path:file,
      sha256:crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
    }));
    const templates = selectorFiles.slice(0,2).map(file => {
      const text = fs.readFileSync(file,"utf8");
      const matches = [...text.matchAll(
        /const candidates = await (?:db|client)\.query\(\s*`([\s\S]*?)`,\s*\[limit(?:, operation)?\]/g
      )];
      assert.equal(matches.length,1,"Expected one discovery query: "+file);
      return matches[0][1];
    });
    const build = (operation,limit,useQueue) => {
      const execution = operation === "settlement_execute";
      const state = execution
        ? "s.status = 'pending'\n       AND s.execution_token IS NULL\n       AND s.execution_started_at IS NULL\n       AND s.scheduled_release_at <= clock_timestamp()"
        : "s.status = 'reconciliation_required'\n       AND s.execution_token IS NOT NULL\n       AND s.execution_started_at IS NOT NULL";
      const order = execution ? "s.scheduled_release_at" : "s.updated_at";
      let text = templates[useQueue ? 1 : 0];
      text = text.replaceAll("${state}",()=>state)
                 .replaceAll("${order}",()=>order);
      assert.ok(!text.includes("${"),"Unresolved discovery interpolation");
      return {text,values:useQueue ? [limit,operation] : [limit]};
    };
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
      for (const operation of ["settlement_execute", "settlement_reconcile"]) {
        for (const distribution of ["eligible"]) {
          for (const table of [...tables, "fixture_seed"]) {
            await client.query("TRUNCATE pg_temp." + quote(table));
          }
          await client.query(
            "INSERT INTO fixture_seed SELECT i, md5(i::text)::uuid FROM generate_series(1, $1::int) i",
            [count]
          );


          await client.query(
            "INSERT INTO host_profiles (id,stripe_connect_account_id,payout_account_status) " +
            "SELECT md5('profile-shared-host')::uuid,'acct_settlement_shared','active' WHERE EXISTS (SELECT 1 FROM fixture_seed)"
          );
          await client.query(
            "INSERT INTO bookings (id,host_id,status,payment_flow_version) " +
            "SELECT id,md5('profile-shared-host')::uuid,'cancelled','separate_charges_delayed_v1' FROM fixture_seed"
          );
          await client.query(
            "INSERT INTO payment_attempts " +
            "(id,booking_id,attempt_number,status,provider_payment_intent_id,amount_minor,currency) " +
            "SELECT id,id,1,'succeeded','pi_settlement_' || i::text,24000,'GBP' FROM fixture_seed"
          );
          await client.query(
            "INSERT INTO booking_price_components " +
            "(id,booking_id,guest_total_minor,host_payout_minor,currency) " +
            "SELECT id,id,24000,20000,'GBP' FROM fixture_seed"
          );
          await client.query(
            "INSERT INTO host_transfer_entitlements " +
            "(id,booking_id,host_id,status,amount_minor,currency,scheduled_release_at) " +
            "SELECT id,id,md5('profile-shared-host')::uuid,'cancellation_settlement_required',20000,'GBP'," +
            "TIMESTAMPTZ '2000-01-01' + i * INTERVAL '1 second' FROM fixture_seed"
          );
          await client.query(
            "INSERT INTO new_flow_refunds " +
            "(id,booking_id,payment_attempt_id,amount_minor,currency,status," +
            "reconciliation_required,provider_refund_id) " +
            "SELECT id,id,id,12000,'GBP'," +
            "CASE WHEN $1::boolean AND i % 10 = 7 THEN 'pending' ELSE 'succeeded' END," +
            "false,'re_settlement_' || i::text FROM fixture_seed",
            [distribution === "mixed"]
          );
          await client.query(
            "INSERT INTO cancellation_host_settlements " +
            "(id,booking_id,host_id,entitlement_id,payment_attempt_id,cancellation_audit_id," +
            "refund_id,amount_minor,original_host_amount_minor,guest_total_minor,refund_amount_minor," +
            "currency,status,idempotency_key,scheduled_release_at,updated_at," +
            "execution_token,execution_started_at) " +
            "SELECT id,id,md5('profile-shared-host')::uuid,id,id,id,id," +
            "CASE WHEN $2::boolean AND i % 10 >= 8 THEN 10001 ELSE 10000 END," +
            "20000,24000,12000,'GBP',$1,'settlement-profile-' || i::text," +
            "TIMESTAMPTZ '2000-01-01' + i * INTERVAL '1 second'," +
            "TIMESTAMPTZ '2000-01-01' + i * INTERVAL '1 second'," +
            "CASE WHEN $3::boolean THEN id ELSE NULL::uuid END," +
            "CASE WHEN $3::boolean THEN TIMESTAMPTZ '1999-01-01' ELSE NULL::timestamptz END " +
            "FROM fixture_seed",
            [operation === "settlement_execute" ? "pending" : "reconciliation_required",
             distribution === "mixed",operation === "settlement_reconcile"]
          );
          await client.query(
            "INSERT INTO audit_log (id,object_id,object_type,action,previous_state,new_state) " +
            "SELECT id,id,'booking','booking_cancelled'," +
            "'{\"status\":\"confirmed\"}'::jsonb," +
            "jsonb_build_object('status','cancelled','cancelledBy','guest','cancellationKind','paid'," +
            "'paymentFlowVersion','separate_charges_delayed_v1'," +
            "'refundPercent',50,'refundableMinor',12000,'hostRetainedMinor',10000," +
            "'refundId',id::text,'reversalId',NULL,'entitlementId',id::text," +
            "'settlementId',id::text,'retainedPayoutSettlementRequired',true) FROM fixture_seed"
          );
          await client.query(
            "INSERT INTO cancellation_settlement_queue_reviews " +
            "(operation,settlement_id,last_reviewed_at,next_review_at,review_failures,last_outcome) " +
            "SELECT $1,id,TIMESTAMPTZ '1999-01-01'," +
            "CASE WHEN $2::boolean AND i % 3 = 0 THEN TIMESTAMPTZ '2100-01-01' " +
            "ELSE TIMESTAMPTZ '2000-01-01' + i * INTERVAL '1 second' END,0,'eligible' " +
            "FROM fixture_seed WHERE i % 3 <> 2",
            [operation,distribution !== "eligible"]
          );

          // Unrelated legacy rows exercise exclusion reads without blocking fixtures.
          for (const table of ["payments","refunds","payouts"]) {
            await client.query(
              "INSERT INTO pg_temp."+quote(table)+" (id,booking_id) "+
              "SELECT md5('legacy-row-' || i::text)::uuid,"+
              "md5('legacy-booking-' || i::text)::uuid FROM fixture_seed"
            );
          }
          await client.query(
            "INSERT INTO host_transfer_reversals (id,entitlement_id) "+
            "SELECT md5('legacy-reversal-' || i::text)::uuid,"+
            "md5('legacy-entitlement-' || i::text)::uuid FROM fixture_seed"
          );
          const shape=(await client.query(
            "SELECT (SELECT count(*)::int FROM host_profiles) AS hosts,"+
            "(SELECT count(DISTINCT host_id)::int FROM bookings) AS booking_hosts,"+
            "(SELECT count(*)::int FROM refunds) AS legacy_refunds"
          )).rows[0];
          assert.equal(shape.hosts,1);
          assert.equal(shape.booking_hosts,1);
          assert.equal(shape.legacy_refunds,count);

          for (const table of tables) {
            await client.query("ANALYZE pg_temp." + quote(table));
          }

          for (const useQueue of [false, true])
            for (const variant of ["baseline_before","refunds_only","payouts_only","both","baseline_after"]) {
              await client.query("DROP INDEX IF EXISTS pg_temp.host_trial_settlement_refunds_booking");
              await client.query("DROP INDEX IF EXISTS pg_temp.host_trial_settlement_payouts_booking");
              if (variant === "refunds_only" || variant === "both") {
                await client.query(
                  "CREATE INDEX host_trial_settlement_refunds_booking ON pg_temp.refunds (booking_id)"
                );
              }
              if (variant === "payouts_only" || variant === "both") {
                await client.query(
                  "CREATE INDEX host_trial_settlement_payouts_booking ON pg_temp.payouts (booking_id)"
                );
              }
              await client.query("ANALYZE pg_temp.refunds");
              await client.query("ANALYZE pg_temp.payouts");
              const trialIndexes=(await client.query(
                "SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema() " +
                "AND relname IN ('host_trial_settlement_refunds_booking','host_trial_settlement_payouts_booking') ORDER BY relname"
              )).rows.map(r=>r.relname);
              const expectedIndexes=[];
              if (variant === "refunds_only" || variant === "both") {
                expectedIndexes.push("host_trial_settlement_refunds_booking");
              }
              if (variant === "payouts_only" || variant === "both") {
                expectedIndexes.push("host_trial_settlement_payouts_booking");
              }
              assert.deepEqual(trialIndexes,expectedIndexes.sort());


            const window = [];
            for (let i=1;i<=count;i++) {
              if (useQueue && distribution !== "eligible" && i % 3 === 0) continue;
              window.push(i);
            }
            const candidateNumbers = window.slice(0,25);
            const expectedCandidates = candidateNumbers.map(id);
            const expected = candidateNumbers.filter(i =>
              distribution !== "mixed" || (i % 10 < 7)
            ).map(id);
            const query = build(operation,25,useQueue);
            assert.match(query.text.trim(),/^SELECT\b/i);
            const captured = new Map();
            await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
            try {
              const checked = async () => {
                const started = performance.now();
                const rows = (await client.query(query.text,query.values)).rows;
                const discoveryMs = performance.now()-started;
                assert.deepEqual(rows.map(r=>r.id),expectedCandidates);
                let eligibilityQueries = 0;
                const reader = {
                  query: async (text,values) => {
                    assert.equal(typeof text,"string");
                    assert.match(text.trim(),/^SELECT\b/i);
                    assert.ok(!/FOR\s+(UPDATE|SHARE)|pg_advisory/i.test(text));
                    eligibilityQueries++;
                    if (!captured.has(text)) captured.set(text,{text,values});
                    return client.query(text,values);
                  }
                };
                const jobs = [];
                const eligibilityStarted = performance.now();
                for (const row of rows) {
                  if (await eligible(reader,String(row.id),operation === "settlement_execute")) {
                    jobs.push(String(row.id));
                  }
                }
                const eligibilityMs = performance.now()-eligibilityStarted;
                assert.deepEqual(jobs,expected);
                assert.ok(eligibilityQueries <= rows.length*3);
                return {discoveryMs,eligibilityMs,eligibilityQueries,totalMs:performance.now()-started};
              };
              await checked();
              const timings = [];
              for (let repeat=0;repeat<3;repeat++) timings.push(await checked());
              const plan = (await client.query(
                "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+query.text,query.values
              )).rows[0]["QUERY PLAN"][0];
              const eligibilityPlans = [];
              for (const statement of captured.values()) {
                const explained = (await client.query(
                  "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+statement.text,
                  statement.values
                )).rows[0]["QUERY PLAN"][0];
                eligibilityPlans.push({
                  sqlSha256:crypto.createHash("sha256").update(statement.text).digest("hex"),
                  text:statement.text,
                  representativeValues:statement.values,
                  plan:explained
                });
              }
              await client.query("COMMIT");
              const median = values => [...values].sort((a,b)=>a-b)[1];
              evidence.cases.push({
                count,operation,distribution,useQueue,variant,
                candidates:expectedCandidates.length,selected:expected.length,
                assertions:"exact candidate window and eligible IDs/order passed",
                samplesMs:timings.map(t=>t.totalMs),
                medianMs:median(timings.map(t=>t.totalMs)),
                medianDiscoveryMs:median(timings.map(t=>t.discoveryMs)),
                medianEligibilityMs:median(timings.map(t=>t.eligibilityMs)),
                eligibilityQueries:timings.map(t=>t.eligibilityQueries),
                sqlSha256:crypto.createHash("sha256").update(query.text).digest("hex"),
                discoverySql:query.text,plan,eligibilityPlans
              });
              console.log(JSON.stringify({
                count,operation,distribution,useQueue,variant,
                candidates:expectedCandidates.length,selected:expected.length,
                medianMs:Number(median(timings.map(t=>t.totalMs)).toFixed(3)),
                discoveryMs:Number(median(timings.map(t=>t.discoveryMs)).toFixed(3)),
                eligibilityMs:Number(median(timings.map(t=>t.eligibilityMs)).toFixed(3)),
                eligibilityQueries:timings[0].eligibilityQueries
              }));
            } catch (error) {
              await client.query("ROLLBACK");
              throw error;
            }
          }
        }
      }
    }
    assert.equal(evidence.cases.length, 40);
    fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
    console.log("TRIAL VERIFIED: 40 cases; exact candidate windows and eligible IDs/order passed across all five index variants.");
    console.log("Saved " + output);
  } finally {
    client.release(true);
    await pool.end();
    if (applicationDb) await applicationDb.end();
  }
}
main().catch(error => {
  console.error("Settlement legacy index trial failed:", error.message);
  process.exitCode = 1;
});
