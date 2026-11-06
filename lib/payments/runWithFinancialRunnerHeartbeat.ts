import type { Pool } from "pg";
import {
  startFinancialRunnerHeartbeat,
  finishFinancialRunnerHeartbeat,
} from "./financialRunnerHeartbeatStore";

export type HeartbeatWrappedResult<T> = {
  execution:
    | {status: "returned"; value: T}
    | {status: "threw"; error: unknown};
  heartbeat:
    | {status: "recorded"}
    | {status: "superseded"}
    | {status: "write_failed"; error: unknown};
};

/**
 * Explicit opt-in wrapper; never schedules, retries or imports financial workers.
 * Start failure throws before invoking the callback.
 * After invocation, callback and completion-write outcomes are returned separately.
 * "returned" does not establish financial success or enabled gates.
 * No periodic pulse: a long-running callback can have a stale start report.
 * The callback must call the intended operation; that association is caller-owned.
 */
export async function runWithFinancialRunnerHeartbeat<T>(
  database: Pick<Pool, "query">,
  operation: string,
  run: () => Promise<T>
): Promise<HeartbeatWrappedResult<T>> {
  if (typeof run !== "function") {
    throw new Error("Invalid heartbeat runner callback");
  }
  const token = await startFinancialRunnerHeartbeat(database, operation);
  let execution: HeartbeatWrappedResult<T>["execution"];
  try {
    execution = {status: "returned", value: await run()};
  } catch (error) {
    execution = {status: "threw", error};
  }
  try {
    const recorded = await finishFinancialRunnerHeartbeat(
      database, operation, token, execution.status
    );
    return {
      execution,
      heartbeat: {status: recorded ? "recorded" : "superseded"}
    };
  } catch (error) {
    return {execution, heartbeat: {status: "write_failed", error}};
  }
}
