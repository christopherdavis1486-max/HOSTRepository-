import fs from "node:fs";
import { Pool } from "pg";
import { collectFinancialMonitoringInputs } from "../lib/payments/collectFinancialMonitoring";
import { retainFinancialMonitoringAlerts } from "../lib/payments/retainFinancialMonitoringAlerts";
import {
  loadFinancialMonitoringAlertHistory,
  saveFinancialMonitoringAlertHistory
} from "../lib/payments/financialMonitoringAlertHistoryFile";
import path from "node:path";
import {
  assessFinancialMonitoring,
  type FinancialMonitoringPolicy
} from "../lib/payments/assessFinancialMonitoring";

/**
 * Explicit local operator command; no scheduling or financial dispatch.
 * Previous and next snapshots are caller-selected in trusted local storage.
 * No latest-pointer selection or concurrent history-chain coordination.
 * A failure after publication may leave a valid next snapshot; inspect before retry.
 * Snapshot data is not authenticated or automatically bound to an environment.
 * Usage: node --import tsx --env-file=.env.test.local
 *   scripts/reportFinancialMonitoringHistory.ts POLICY_JSON PREVIOUS_JSON_OR_DASH NEXT_JSON
 * Exit 0: no pending conditions. Exit 2 includes retained unconfirmed conditions.
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
  if (args.length !== 3 || args.some(value => !value)) {
    throw new Error("Policy, explicit previous snapshot or dash, and next snapshot required");
  }
  const next = path.resolve(args[2]);
  if (fs.existsSync(next)) throw new Error("Next snapshot already exists");
  if (next === path.resolve(args[0]) ||
      (args[1] !== "-" && next === path.resolve(args[1]))) {
    throw new Error("Snapshot paths must be distinct");
  }
  const policy: FinancialMonitoringPolicy = JSON.parse(fs.readFileSync(args[0], "utf8"));
  const absent = {status: "unavailable" as const, reason: "collection_failed" as const};
  assessFinancialMonitoring(absent, absent, policy);
  // Dash explicitly initializes history. A missing named snapshot is an error.
  const previous = args[1] === "-"
    ? null : loadFinancialMonitoringAlertHistory(args[1]);

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

    const inputs = await collectFinancialMonitoringInputs(pool, pool, policy);
    const result = retainFinancialMonitoringAlerts(previous, inputs);
    // Save before output. Failure is visible and never resets history.
    saveFinancialMonitoringAlertHistory(next, result.state);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.state.pending.length > 0 ? 2 : 0;
    return result;

  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error("Financial monitoring history report failed; inspect configuration and snapshot files before retrying. No financial workers were invoked.");
    process.exitCode = 1;
  });
}
