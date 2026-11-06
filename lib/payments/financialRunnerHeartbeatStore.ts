import crypto from "node:crypto";
import type { Pool } from "pg";
import { financialQueueHealthOperations } from "./readFinancialQueueHealth";

type HeartbeatDatabase = Pick<Pool, "query">;
export type FinancialRunnerHeartbeatRecord = {
  operation: string;
  runToken: string;
  startedAt: string;
  reportedAt: string;
  finishedAt: string | null;
  outcome: "started" | "returned" | "threw";
};

const known = new Set<string>(financialQueueHealthOperations);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateOperation(operation: string): void {
  if (!known.has(operation)) throw new Error("Invalid heartbeat operation");
}

/**
 * Explicit monitoring write, using database receipt time.
 * A new start supersedes the prior token; it does not exclude concurrent work.
 * Callers must never use this record as financial authorization or a lease.
 */
export async function startFinancialRunnerHeartbeat(
  database: HeartbeatDatabase,
  operation: string
): Promise<string> {
  validateOperation(operation);
  const token = crypto.randomUUID();
  const result = await database.query(
    `INSERT INTO financial_runner_heartbeats
       (operation, run_token, started_at, reported_at, finished_at, outcome)
     SELECT $1, $2::uuid, at, at, NULL, 'started'
       FROM (SELECT clock_timestamp() AS at) stamp
     ON CONFLICT (operation) DO UPDATE SET
       run_token = EXCLUDED.run_token,
       started_at = clock_timestamp(),
       reported_at = clock_timestamp(),
       finished_at = NULL,
       outcome = 'started'
     RETURNING run_token`,
    [operation, token]
  );
  if (result.rows.length !== 1 || result.rows[0].run_token !== token) {
    throw new Error("Invalid heartbeat start result");
  }
  return token;
}

/**
 * Conditional feedback only. False means this run no longer owns the
 * monitoring token or already reported completion. Never retry financial work.
 * "returned" describes callback return, not financial success or enabled gates.
 */
export async function finishFinancialRunnerHeartbeat(
  database: HeartbeatDatabase,
  operation: string,
  token: string,
  outcome: "returned" | "threw"
): Promise<boolean> {
  validateOperation(operation);
  if (typeof token !== "string" || !uuid.test(token) ||
      !["returned", "threw"].includes(outcome)) {
    throw new Error("Invalid heartbeat completion");
  }
  const result = await database.query(
    `WITH stamp AS MATERIALIZED (
       SELECT clock_timestamp() AS at
     )
     UPDATE financial_runner_heartbeats h
     SET reported_at = GREATEST(stamp.at, h.reported_at, h.started_at),
         finished_at = GREATEST(stamp.at, h.reported_at, h.started_at),
         outcome = $3
     FROM stamp
     WHERE h.operation = $1 AND h.run_token = $2::uuid
       AND h.outcome = 'started'
     RETURNING h.run_token`,
    [operation, token, outcome]
  );
  if (result.rows.length > 1 ||
      (result.rows.length === 1 && result.rows[0].run_token !== token)) {
    throw new Error("Invalid heartbeat completion result");
  }
  return result.rows.length === 1;
}
