import fs from "node:fs";
import { Pool } from "pg";
import { collectFinancialMonitoringInputs } from "../lib/payments/collectFinancialMonitoring";
import { retainFinancialMonitoringAlerts } from "../lib/payments/retainFinancialMonitoringAlerts";
import {
  loadBoundFinancialMonitoringHistory,
  saveBoundFinancialMonitoringHistory
} from "../lib/payments/financialMonitoringBoundHistoryFile";
import { encodeBoundFinancialMonitoringHistory,
  type FinancialMonitoringHistoryIdentity
} from "../lib/payments/financialMonitoringBoundHistoryCodec";
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
 * Snapshot identity is checked; the environment label is operator supplied.
 * Database/schema checks do not authenticate files or identify a server cluster.
 * Usage: node --import tsx --env-file=.env.test.local
 *   scripts/reportFinancialMonitoringBoundHistory.ts POLICY_JSON PREVIOUS_JSON_OR_DASH NEXT_JSON IDENTITY_JSON
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
  if (args.length !== 4 || args.some(value => !value)) {
    throw new Error("Policy, explicit previous snapshot or dash, next snapshot and identity required");
  }
  const binding: FinancialMonitoringHistoryIdentity = JSON.parse(fs.readFileSync(args[3], "utf8"));
  encodeBoundFinancialMonitoringHistory({assessedAt: new Date(0).toISOString(), pending: []}, binding);
  if (binding.database !== "host_test") throw new Error("Local host_test identity required");
  const next = path.resolve(args[2]);
  if (fs.existsSync(next)) throw new Error("Next snapshot already exists");
  if (next === path.resolve(args[3]) || next === path.resolve(args[0]) ||
      (args[1] !== "-" && next === path.resolve(args[1]))) {
    throw new Error("Snapshot paths must be distinct");
  }
  const policy: FinancialMonitoringPolicy = JSON.parse(fs.readFileSync(args[0], "utf8"));
  const absent = {status: "unavailable" as const, reason: "collection_failed" as const};
  assessFinancialMonitoring(absent, absent, policy);
  // Dash explicitly initializes history. A missing named snapshot is an error.
  const previous = args[1] === "-"
    ? null : loadBoundFinancialMonitoringHistory(args[1], binding);

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

    const client = await pool.connect();
    try {
      const identity = (await client.query(
        "SELECT current_database() AS name, host(inet_server_addr()) AS address, " +
        "current_setting('default_transaction_read_only') AS read_only"
      )).rows[0];
      if (!identity || identity.name !== binding.database ||
          !["127.0.0.1", "::1"].includes(identity.address) ||
          identity.read_only !== "on") {
        throw new Error("Read-only local database identity verification failed");
      }
      const namespace = await client.query(
        "SELECT oid FROM pg_catalog.pg_namespace WHERE nspname=$1",
        [binding.schema]
      );
      if (namespace.rows.length !== 1 ||
          binding.schema === "pg_catalog" ||
          binding.schema.startsWith("pg_temp") ||
          binding.schema.startsWith("pg_toast")) {
        throw new Error("Explicit application schema required");
      }
      await client.query(
        "SELECT pg_catalog.set_config('search_path',$1,false)",
        ['"' + binding.schema + '",pg_catalog']
      );
      const tables = [
        "cancellation_settlement_queue_reviews",
        "new_flow_payment_queue_reviews",
        "new_flow_refund_queue_reviews",
        "host_transfer_queue_reviews",
        "transfer_reversal_queue_reviews",
        "financial_runner_heartbeats"
      ];
      const resolved = await client.query(
        "SELECT expected.name, n.nspname AS schema_name " +
        "FROM unnest($1::text[]) AS expected(name) " +
        "LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(expected.name) " +
        "LEFT JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace",
        [tables]
      );
      if (resolved.rows.length !== tables.length ||
          resolved.rows.some(row =>
            row.schema_name !== null && row.schema_name !== binding.schema)) {
        throw new Error("Monitoring tables resolve outside the selected schema");
      }
      // Missing tables remain collection findings. Existing tables must match.
      // Keep all reads on this verified session, including queue transactions.
      let discarded = false;
      const queueDatabase = {
        connect: async () => {
          if (discarded) throw new Error("Monitoring session discarded");
          return {
            query: client.query.bind(client),
            release: (discard?: boolean) => { discarded = discard === true; }
          };
        }
      } as unknown as Parameters<typeof collectFinancialMonitoringInputs>[0];
      const heartbeatDatabase = {
        query: async (sql: string, values?: any[]) => {
          if (discarded) throw new Error("Monitoring session discarded");
          return client.query(sql, values);
        }
      } as Parameters<typeof collectFinancialMonitoringInputs>[1];
      const inputs = await collectFinancialMonitoringInputs(
        queueDatabase, heartbeatDatabase, policy
      );

    const result = retainFinancialMonitoringAlerts(previous, inputs);
    // Save before output. Failure is visible and never resets history.
    saveBoundFinancialMonitoringHistory(next, result.state, binding);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.state.pending.length > 0 ? 2 : 0;
    return result;
    } finally {
      client.release(true);
    }

  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error("Financial monitoring bound history report failed; inspect configuration and snapshot files before retrying. No financial workers were invoked.");
    process.exitCode = 1;
  });
}
