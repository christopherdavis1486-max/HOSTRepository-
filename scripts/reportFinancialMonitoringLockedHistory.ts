import path from "node:path";
import {main as boundMain} from "./reportFinancialMonitoringBoundHistory";
import {withFinancialMonitoringHistoryLock as lock}
  from "../lib/payments/withFinancialMonitoringHistoryLock";

/**
 * Local cooperating callers must use one canonical lock path per chain.
 * Usage: POLICY_JSON PREVIOUS_JSON_OR_DASH NEXT_JSON IDENTITY_JSON LOCK_FILE
 * Does not establish latest-predecessor selection or distributed coordination.
 * A crash leaves the lock for manual inspection; never remove an active lock.
 */
export async function main(
  args = process.argv.slice(2),
  createPool?: Parameters<typeof boundMain>[1]
) {
  if (args.length !== 5 || args.some(value => !value)) {
    throw new Error("Five explicit locked-history arguments required");
  }
  const lockFile = path.resolve(args[4]);
  const protectedPaths = [args[0], args[2], args[3]];
  if (args[1] !== "-") protectedPaths.push(args[1]);
  if (protectedPaths.some(file => path.resolve(file) === lockFile)) {
    throw new Error("Lock path must differ from input and output paths");
  }
  return lock(lockFile, () => boundMain(args.slice(0, 4), createPool));
}

if (require.main === module) {
  main().catch(() => {
    console.error("Financial monitoring locked history report failed; inspect the lock and snapshot files before retrying. No financial workers were invoked.");
    process.exitCode = 1;
  });
}
