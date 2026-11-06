import type { Pool } from "pg";
import { financialQueueHealthOperations } from "./readFinancialQueueHealth";
import type { FinancialRunnerHeartbeatRecord } from "./financialRunnerHeartbeatStore";

function timestamp(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Invalid stored heartbeat timestamp");
  }
  return value.toISOString();
}

/**
 * One bounded SELECT of monitoring metadata only.
 * Missing operations remain absent for the assessor to classify.
 * Query/schema failures propagate; never substitute a healthy empty result.
 * The caller supplies connection, timeout and read-only session policy.
 */
export async function readFinancialRunnerHeartbeats(
  database: Pick<Pool, "query">
): Promise<FinancialRunnerHeartbeatRecord[]> {
  const result = await database.query(
    `SELECT operation, run_token, started_at, reported_at, finished_at, outcome
       FROM financial_runner_heartbeats
       ORDER BY operation LIMIT 11`
  );
  const known = new Set<string>(financialQueueHealthOperations);
  const seen = new Set<string>();
  if (result.rows.length > known.size) {
    throw new Error("Invalid stored heartbeat coverage");
  }
  return result.rows.map(row => {
    if (!known.has(row.operation) || seen.has(row.operation) ||
        typeof row.run_token !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.run_token) ||
        !["started", "returned", "threw"].includes(row.outcome)) {
      throw new Error("Invalid stored heartbeat record");
    }
    seen.add(row.operation);
    const startedAt = timestamp(row.started_at);
    const reportedAt = timestamp(row.reported_at);
    const finishedAt = row.finished_at === null ? null : timestamp(row.finished_at);
    if (reportedAt < startedAt ||
        (row.outcome === "started" ? finishedAt !== null :
          finishedAt === null || finishedAt < startedAt || finishedAt !== reportedAt)) {
      throw new Error("Inconsistent stored heartbeat timestamps");
    }
    return {
      operation: row.operation, runToken: row.run_token,
      startedAt, reportedAt, finishedAt, outcome: row.outcome
    };
  });
}
