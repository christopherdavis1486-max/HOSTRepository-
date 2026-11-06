import { Pool } from "pg";
import { readFinancialQueueHealth } from "../lib/payments/readFinancialQueueHealth";

/**
 * Local operator report only.
 * Run: node --import tsx --env-file=.env.test.local scripts/reportFinancialQueueHealth.ts
 * No dotenv loading, environment changes, provider imports or worker dispatch.
 */
async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Local database configuration is missing");
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("Invalid local database configuration");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname) ||
      decodeURIComponent(url.pathname.slice(1)) !== "host_test") {
    throw new Error("Queue health command requires loopback host_test");
  }

  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5000,
    options: "-c default_transaction_read_only=on",
  });
  try {
    const identity = (await pool.query(
      "SELECT current_database() AS name, host(inet_server_addr()) AS address, current_setting('default_transaction_read_only') AS read_only"
    )).rows[0];
    if (identity.name !== "host_test" ||
        !["127.0.0.1", "::1"].includes(identity.address) ||
        identity.read_only !== "on") {
      throw new Error("Local read-only database identity verification failed");
    }
    const report = await readFinancialQueueHealth(pool);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    const code = typeof error?.code === "string" && /^[A-Z0-9]{5}$/.test(error.code)
      ? ` (database code ${error.code})` : "";
    console.error("Queue health report failed" + code + "; no financial workers were invoked.");
    process.exitCode = 1;
  });
}
