import assert from "node:assert/strict";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { readFinancialQueueHealth } from "../lib/payments/readFinancialQueueHealth";

const definitions = [
  ["042_cancellation_settlement_queue_reviews.sql", "cancellation_settlement_queue_reviews", "settlement_id", ["settlement_execute", "settlement_reconcile"]],
  ["043_new_flow_payment_queue_reviews.sql", "new_flow_payment_queue_reviews", "payment_attempt_id", ["payment_reconcile", "missing_refund_recover"]],
  ["044_new_flow_refund_queue_reviews.sql", "new_flow_refund_queue_reviews", "refund_id", ["refund_execute", "refund_reconcile"]],
  ["045_host_transfer_queue_reviews.sql", "host_transfer_queue_reviews", "entitlement_id", ["transfer_execute", "transfer_reconcile"]],
  ["046_transfer_reversal_queue_reviews.sql", "transfer_reversal_queue_reviews", "reversal_id", ["reversal_execute", "reversal_reconcile"]],
] as const;

const outputPath = "docs/financial-queue-health-profile-2026-10-21.json";

async function main() {
  assert.ok(!fs.existsSync(outputPath), "Profile output exists; inspect before rerunning");
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname));
  assert.equal(decodeURIComponent(url.pathname.slice(1)), "host_test");

  const pool = new Pool({
    connectionString:url.toString(), max:1, connectionTimeoutMillis:5000,
  });
  const client = await pool.connect();
  let captured: {text:string; values:any[]} | undefined;
  let releases = 0;
  const reportPool = {
    connect: async () => ({
      query: async (text:string, values?:any[]) => {
        if (text.includes("WITH expected AS")) {
          assert.equal(
            (await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only,
            "on"
          );
          captured = {text, values:values!};
        }
        return client.query(text, values);
      },
      release: (discard?:boolean) => {
        assert.notEqual(discard, true, "Reporting connection became unusable");
        releases++;
      },
    }),
  } as unknown as Pick<Pool, "connect">;

  const measurements: any[] = [];
  try {
    const identity = (await client.query(
      "SELECT current_database() AS name, host(inet_server_addr()) AS address, version() AS version"
    )).rows[0];
    assert.equal(identity.name, "host_test");
    assert.ok(["127.0.0.1", "::1"].includes(identity.address));

    await client.query("SET statement_timeout = '30s'");
    await client.query("SET lock_timeout = '2s'");
    for (const [migration, table] of definitions) {
      const sql = fs.readFileSync("migrations/" + migration, "utf8").replace(
        "CREATE TABLE " + table, () => "CREATE TEMP TABLE " + table
      );
      await client.query(sql);
      const namespace = (await client.query(
        "SELECT relnamespace = pg_my_temp_schema() AS temporary FROM pg_class WHERE oid = to_regclass($1)",
        [table]
      )).rows[0];
      assert.equal(namespace.temporary, true, "Fixture table is not temporary");
    }

    for (const perOperation of [0, 100, 1000, 10000]) {
      for (const [, table, idColumn, operations] of definitions) {
        await client.query(`TRUNCATE pg_temp.${table}`);
        const settlement = table === "cancellation_settlement_queue_reviews";
        for (const operation of operations) {
          const outcome = settlement
            ? "CASE WHEN g % 2 = 0 THEN 'eligible' ELSE 'review_required' END"
            : "CASE WHEN g % 4 IN (0, 3) THEN 'selected' WHEN g % 4 = 1 THEN 'unresolved' ELSE 'resolved' END";
          const failures = settlement
            ? "CASE WHEN g % 2 = 1 THEN (g % 17)::smallint ELSE 0 END"
            : "CASE WHEN g % 4 = 1 THEN (g % 17)::smallint ELSE 0 END";
          await client.query(`
            INSERT INTO pg_temp.${table}
              (operation, ${idColumn}, last_reviewed_at, next_review_at,
               review_failures, last_outcome${settlement ? "" : ", review_token"})
            SELECT $1, md5($1 || ':' || g::text)::uuid,
              clock_timestamp() - INTERVAL '2 days',
              clock_timestamp() + CASE WHEN g % 3 = 0
                THEN INTERVAL '-1 day' ELSE INTERVAL '1 day' END,
              ${failures}, ${outcome}${settlement ? "" : ", md5('review:' || $1 || ':' || g::text)::uuid"}
            FROM generate_series(1, $2::int) AS series(g)
          `, [operation, perOperation]);
        }
        await client.query(`ANALYZE pg_temp.${table}`);
      }

      const check = (report: Awaited<ReturnType<typeof readFinancialQueueHealth>>) => {
        assert.equal(report.rows.length, 10);
        for (const row of report.rows) {
          const settlement = row.operation.startsWith("settlement_");
          const expected = {
            total:perOperation, due:0, cooling:0, selectedAwaitingFeedback:0,
            selectedDue:0, unresolved:0, backingOff:0, resolved:0, eligible:0,
          };
          let maxFailures = 0;
          for (let g = 1; g <= perOperation; g++) {
            const due = g % 3 === 0;
            expected[due ? "due" : "cooling"]++;
            const unresolved = settlement ? g % 2 === 1 : g % 4 === 1;
            const failures = unresolved ? g % 17 : 0;
            maxFailures = Math.max(maxFailures, failures);
            if (unresolved) {
              expected.unresolved++;
              if (!due && failures > 0) expected.backingOff++;
            } else if (settlement) {
              expected.eligible++;
            } else if (g % 4 === 2) {
              expected.resolved++;
            } else {
              expected.selectedAwaitingFeedback++;
              if (due) expected.selectedDue++;
            }
          }
          for (const [field, value] of Object.entries(expected)) {
            assert.equal(
              row[field as keyof typeof row], String(value),
              `Count mismatch: ${row.operation}/${field}`
            );
          }
          assert.equal(row.maxReviewFailures, maxFailures);
        }
      };

      check(await readFinancialQueueHealth(reportPool));
      const elapsedMs: number[] = [];
      for (let run = 0; run < 3; run++) {
        const start = performance.now();
        const report = await readFinancialQueueHealth(reportPool);
        elapsedMs.push(Number((performance.now() - start).toFixed(3)));
        check(report);
      }
      assert.ok(captured);

      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      let explanation: any;
      try {
        await client.query("SET LOCAL statement_timeout = '5s'");
        await client.query("SET LOCAL lock_timeout = '2s'");
        explanation = (await client.query(
          "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + captured.text,
          captured.values
        )).rows[0]["QUERY PLAN"][0];
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      const sorted = [...elapsedMs].sort((a,b) => a-b);
      const measurement = {
        perOperation, totalRows:perOperation * 10,
        warmupRuns:1, measuredRuns:3,
        reportElapsedMs:elapsedMs, medianReportMs:sorted[1],
        planningMs:explanation["Planning Time"],
        executionMs:explanation["Execution Time"],
        resultRows:explanation.Plan["Actual Rows"],
        plan:explanation,
      };
      measurements.push(measurement);
      console.log(JSON.stringify({
        totalRows:measurement.totalRows,
        medianReportMs:measurement.medianReportMs,
        planningMs:measurement.planningMs,
        executionMs:measurement.executionMs,
        resultRows:measurement.resultRows,
      }));
    }
    assert.equal(releases, 16);

    const result = {
      createdAt:new Date().toISOString(),
      scope:"queue-health aggregation only; temporary scheduling metadata",
      database:"host_test at loopback",
      postgresVersion:identity.version,
      nodeVersion:process.version,
      fixturePattern:"equal rows per operation; deterministic mixed outcomes and due/cooling times",
      measurements,
      limitations:[
        "Local synthetic measurements, not production capacity guarantees.",
        "Warm-cache runs; three measured runs per scale are not latency percentiles.",
        "Temporary tables and isolated load do not model concurrent production traffic, storage or WAL.",
        "Financial discovery predicates, selectors, workers and providers were not profiled.",
        "Report timings include a read-only-setting assertion used by this harness.",
        "EXPLAIN execution is an additional instrumented query and differs from normal report timing.",
        "No persistent rows, migrations, configuration changes or index changes.",
      ],
    };
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2)+"\n", {flag:"wx"});
    console.log("Profile saved: " + outputPath);
  } finally {
    try { await client.query("ROLLBACK"); }
    finally {
      client.release(true);
      await pool.end();
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Queue health profiling failed");
  process.exitCode = 1;
});
