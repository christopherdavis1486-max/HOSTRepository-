
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { performance } = require("node:perf_hooks");

const output = "docs/settlement-queue-contention-2026-10-21.json";
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
  let cleanup;
  const client = await pool.connect();
  const evidence = {
    observedAt: new Date().toISOString(),
    scope: "synthetic_settlement_queue_advisory_contention",
    scales: [100],
    fixtureLimitations: [
      "Temporary tables retain local column types and indexes, but constraints and defaults are not reproduced.",
      "Unused columns are null; row widths and distributions do not reproduce production.",
      "Warm local single-session measurements; no concurrent load or production capacity claim.",
      "Extracted unchanged discovery SQL plus real advisory eligibility helper; no queue writes, locking, claims, dispatch or provider operations.",
      "Queue review writes, advisory locking, concurrent changes and larger scales remain unmeasured."
    ],
    sourceScriptSha256: "b1f6d2260256d540b11f03a07c3de51435098b9127872d3b8c52c9a65154c320",
    fixtureDescription: "Real settlement eligibility; 50 percent paid cancellations with verified refunds; mixed retained-amount mismatches and pending refunds; bounded candidate window before eligibility filtering",
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
    const { reviewCancellationSettlementQueue: review } =
      require("../lib/payouts/reviewCancellationSettlementQueue.ts");
    const flags = [
      "ENABLE_CANCELLATION_HOST_SETTLEMENT_EXECUTION",
      "ENABLE_CANCELLATION_HOST_SETTLEMENT_RECONCILIATION"
    ];
    const savedFlags = flags.map(f=>process.env[f]);
    const originalConnect = applicationDb.connect;
    let activeStats = null;
    const suppliedClient = {
      release() {},
      async query(text,values) {
        assert.ok(activeStats,"Unexpected application database query");
        assert.equal(typeof text,"string");
        const trimmed=text.trim();
        const queueWrite=/^WITH checked AS/.test(trimmed) &&
          /INSERT INTO cancellation_settlement_queue_reviews/.test(text);
        assert.ok(queueWrite || /^(SELECT|SET LOCAL|BEGIN|COMMIT|ROLLBACK)\b/i.test(trimmed),
          "Unexpected SQL in review transaction");
        assert.ok(!/\b(UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\s/i.test(trimmed) ||
          queueWrite,"Unexpected financial mutation");
        const category=queueWrite ? "queueWrite" :
          /pg_try_advisory_xact_lock/.test(text) ? "advisoryLock" :
          /^SELECT s\.id,/.test(trimmed) ? "discovery" :
          /^SELECT/i.test(trimmed) ? "eligibility" :
          /^SET LOCAL/i.test(trimmed) ? "settings" : "transaction";
        const start=performance.now();
        try { return await client.query(text,values); }
        finally {
          activeStats[category].queries++;
          activeStats[category].ms+=performance.now()-start;
        }
      }
    };
    applicationDb.connect=async()=> {
      assert.ok(activeStats,"Unexpected application pool checkout");
      return suppliedClient;
    };
    cleanup=()=>{
      applicationDb.connect=originalConnect;
      flags.forEach((f,i)=>{
        if(savedFlags[i]===undefined) delete process.env[f];
        else process.env[f]=savedFlags[i];
      });
    };
    evidence.measurement="Real queue-review function and eligibility; application checkout routed to one isolated temporary-table client";
    evidence.fixtureLimitations=[
      "Warm local temporary tables; simplified constraints and row widths.",
      "One host per booking; one 50 percent cancellation policy; empty legacy exclusion tables.",
      "Includes real BEGIN/COMMIT, settings, advisory acquisition, eligibility and queue writes.",
      "Pool acquisition is routed directly to the fixture client; normal pool wait is excluded.",
      "Temporary-table writes do not measure persistent-table WAL, durability, replication or production index maintenance.",
      "Uncontended advisory acquisition only; no concurrency or production capacity claim.",
      "Queue fixture reset, validation and financial snapshots are outside timing.",
      "Instrumentation and JavaScript overhead remain in total timing."
    ];

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
            "SELECT id,'acct_settlement_' || i::text,'active' FROM fixture_seed"
          );
          await client.query(
            "INSERT INTO bookings (id,host_id,status,payment_flow_version) " +
            "SELECT id,id,'cancelled','separate_charges_delayed_v1' FROM fixture_seed"
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
            "SELECT id,id,id,'cancellation_settlement_required',20000,'GBP'," +
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
            "SELECT id,id,id,id,id,id,id," +
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
          for (const table of tables) {
            await client.query("ANALYZE pg_temp." + quote(table));
          }

          for (const useQueue of [true]) {




            flags.forEach(f=>delete process.env[f]);
            process.env[operation==="settlement_execute"?flags[0]:flags[1]]="true";
            evidence.fixtureLimitations=[
              "Two local sessions; 100 simplified temporary fixtures; one host per booking.",
              "Real review and eligibility; application checkout routed to fixture client.",
              "Holder acquires the real database-wide operation advisory key.",
              "No financial workers, provider calls or persistent fixture writes.",
              "Four fixed-order samples per scenario including warmup; no throughput or latency guarantee.",
              "Measures advisory-key contention, not row-lock conflicts or sustained concurrent traffic."
            ];
            const baseline=(await client.query(
              "SELECT * FROM cancellation_settlement_queue_reviews ORDER BY operation,settlement_id"
            )).rows;
            const financialSnapshot=async()=>{
              const hashes=[];
              for(const table of tables.filter(t=>t!=="cancellation_settlement_queue_reviews")) {
                hashes.push((await client.query(
                  "SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'[]')) AS hash FROM pg_temp."+quote(table)+" t"
                )).rows[0].hash);
              }
              return hashes;
            };
            const beforeFinancial=await financialSnapshot();
            const reset=async()=>{
              await client.query("TRUNCATE pg_temp.cancellation_settlement_queue_reviews");
              await client.query(
                "INSERT INTO pg_temp.cancellation_settlement_queue_reviews SELECT * FROM json_populate_recordset(NULL::pg_temp.cancellation_settlement_queue_reviews,$1::json)",
                [JSON.stringify(baseline)]
              );
            };
            const stats=()=>Object.fromEntries(
              ["queueWrite","advisoryLock","discovery","eligibility","settings","transaction"]
                .map(k=>[k,{queries:0,ms:0}])
            );
            const expected=Array.from({length:25},(_,i)=>({operation,id:id(i+1)}));
            const holderPool=new Pool({
              connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:5000
            });
            let holder;
            try {
              holder=await holderPool.connect();
              const identity=(await holder.query(
                "SELECT current_database() AS name,host(inet_server_addr()) AS address,pg_backend_pid() AS pid"
              )).rows[0];
              assert.equal(identity.name,"host_test");
              assert.ok(["127.0.0.1","::1"].includes(identity.address));
              assert.notEqual(identity.pid,(await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
              await holder.query("SET statement_timeout='5s'");
              await holder.query("SET idle_in_transaction_session_timeout='15s'");
              for(const conflict of ["same_operation","other_operation"]) {
                const heldOperation=conflict==="same_operation"?operation:
                  operation==="settlement_execute"?"settlement_reconcile":"settlement_execute";
                const samples=[],phases=[];
                for(let repeat=0;repeat<4;repeat++) {
                  await reset();
                  await holder.query("BEGIN");
                  try {
                    const lock=(await holder.query(
                      "SELECT pg_try_advisory_xact_lock(hashtext('host:cancellation-settlement-queue-review'),hashtext($1)) AS acquired",
                      [heldOperation]
                    )).rows[0];
                    assert.equal(lock.acquired,true,"Could not acquire isolated contention fixture lock");
                    const phase=stats();
                    activeStats=phase;
                    let jobs,elapsed;
                    const began=performance.now();
                    try {
                      jobs=await review(operation,25);
                      elapsed=performance.now()-began;
                    } finally { activeStats=null; }
                    assert.deepEqual(jobs,conflict==="same_operation"?[]:expected);
                    assert.equal(phase.advisoryLock.queries,1);
                    assert.equal(phase.queueWrite.queries,conflict==="same_operation"?0:25);
                    assert.equal(phase.discovery.queries,conflict==="same_operation"?0:1);
                    assert.equal(phase.eligibility.queries,conflict==="same_operation"?0:75);
                    assert.equal(phase.transaction.queries,2);
                    if(conflict==="same_operation") {
                      const after=(await client.query(
                        "SELECT * FROM cancellation_settlement_queue_reviews ORDER BY operation,settlement_id"
                      )).rows;
                      assert.deepEqual(after,baseline);
                    }
                    if(repeat>0) { samples.push(elapsed); phases.push(phase); }
                  } finally { await holder.query("ROLLBACK"); }
                  // Once the holder releases, the reviewed operation must proceed.
                  await reset();
                  activeStats=stats();
                  try { assert.deepEqual(await review(operation,25),expected); }
                  finally { activeStats=null; }
                }
                const medianMs=[...samples].sort((a,b)=>a-b)[1];
                evidence.cases.push({
                  count,operation,conflict,heldOperation,samplesMs:samples,medianMs,phases,
                  assertions:"held-lock behavior, operation independence, release recovery and financial immutability passed"
                });
                console.log(JSON.stringify({operation,conflict,medianMs:Number(medianMs.toFixed(3))}));
              }
            } finally {
              if(holder) {
                try { await holder.query("ROLLBACK"); }
                finally { holder.release(true); }
              }
              await holderPool.end();
            }
            assert.deepEqual(await financialSnapshot(),beforeFinancial);
          }
        }
      }
    }
    assert.equal(evidence.cases.length, 4);
    fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
    console.log("CONTENTION VERIFIED: four scenarios; same-operation skip, independent operation and recovery after release passed.");
    console.log("Saved " + output);
  } finally {
    client.release(true);
    await pool.end();
    if (cleanup) cleanup();
    if (applicationDb) await applicationDb.end();
  }
}
main().catch(error => {
  console.error("Settlement contention profile failed:", error.message);
  process.exitCode = 1;
});
