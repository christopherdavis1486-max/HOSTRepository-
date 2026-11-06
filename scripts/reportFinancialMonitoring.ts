import fs from "node:fs";
import { Pool } from "pg";
import { collectFinancialMonitoring } from "../lib/payments/collectFinancialMonitoring";
import {
  assessFinancialMonitoring,
  type FinancialMonitoringPolicy
} from "../lib/payments/assessFinancialMonitoring";

/**
 * Explicit local operator command; no scheduling or financial dispatch.
 * Usage: node --import tsx --env-file=.env.test.local
 *   scripts/reportFinancialMonitoring.ts PATH_TO_POLICY_JSON
 * Exit 0: no configured monitoring observations require attention.
 * Exit 1: command/configuration failure. Exit 2: monitoring requires attention.
 * No exit code establishes financial success or production readiness.
 */
type MonitoringPool = Pick<Pool, "query" | "connect" | "end">;
type MonitoringPoolFactory =
  (options: ConstructorParameters<typeof Pool>[0]) => MonitoringPool;

export async function main(
  args = process.argv.slice(2),
  createPool: MonitoringPoolFactory = options => new Pool(options)
) {
  if (args.length !== 1) throw new Error("Explicit monitoring policy file required");
  const policy: FinancialMonitoringPolicy = JSON.parse(fs.readFileSync(args[0], "utf8"));
  const absent = {status: "unavailable" as const, reason: "collection_failed" as const};
  assessFinancialMonitoring(absent, absent, policy);

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Local database configuration missing");
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname) ||
      decodeURIComponent(url.pathname.slice(1)) !== "host_test") {
    throw new Error("Monitoring command requires loopback host_test");
  }
  const pool = createPool({
    connectionString, max: 1, connectionTimeoutMillis: 5000,
    options: "-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=2000"
  });
  try {
    const identity = (await pool.query(
      "SELECT current_database() AS name, host(inet_server_addr()) AS address, " +
      "current_setting('default_transaction_read_only') AS read_only"
    )).rows[0];
    if (identity.name !== "host_test" ||
        !["127.0.0.1", "::1"].includes(identity.address) ||
        identity.read_only !== "on") {
      throw new Error("Read-only local database identity verification failed");
    }
    const report = await collectFinancialMonitoring(pool, pool, policy);
    console.log(JSON.stringify(report, null, 2));
    const attention = report.operations.some(row =>
      row.queue.status === "unavailable" ||
      (row.queue.status === "observed" &&
        (row.queue.assessment.disposition === "configuration_required" ||
         row.queue.assessment.observations.length > 0)) ||
      !["recent", "paused"].includes(row.heartbeat.status) ||
      row.heartbeat.outcome === "threw"
    );
    if (attention) process.exitCode = 2;
    return report;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error("Financial monitoring report failed; check policy and local database configuration. No financial workers were invoked.");
    process.exitCode = 1;
  });
}
