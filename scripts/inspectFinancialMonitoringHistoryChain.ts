import fs from "node:fs";
import {inspectFinancialMonitoringHistoryChain as inspect}
  from "../lib/payments/inspectFinancialMonitoringHistoryChain";

/**
 * Usage: CHAIN_DIRECTORY IDENTITY_JSON
 * Exit 0: inspection succeeded, including empty or pending history.
 * Exit 1: inspection failed. This command never assesses fresh evidence.
 */
export function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args.some(value => !value)) {
    throw new Error("Chain directory and identity file required");
  }
  const identity = JSON.parse(fs.readFileSync(args[1], "utf8"));
  const result = inspect(args[0], identity);
  const output = {
    scope: "stored_monitoring_history_inspection_only",
    recordCount: result.recordCount,
    head: result.head,
    assessedAt: result.state?.assessedAt ?? null,
    pendingCount: result.state?.pending.length ?? 0
  };
  console.log(JSON.stringify(output, null, 2));
  return output;
}

if (require.main === module) {
  try { main(); }
  catch {
    console.error("Financial monitoring history inspection failed; preserve files and inspect configuration. No history was changed.");
    process.exitCode = 1;
  }
}
