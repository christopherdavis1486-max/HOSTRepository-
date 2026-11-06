import {
  assessFinancialMonitoring,
  type FinancialMonitoringPolicy,
  type MonitoringSource
} from "./assessFinancialMonitoring";
import { readFinancialQueueHealth } from "./readFinancialQueueHealth";
import { readFinancialRunnerHeartbeats } from "./readFinancialRunnerHeartbeats";

type QueueReport = Awaited<ReturnType<typeof readFinancialQueueHealth>>;
type HeartbeatReports = Awaited<ReturnType<typeof readFinancialRunnerHeartbeats>>;
type Readers = {
  queue: typeof readFinancialQueueHealth;
  heartbeats: typeof readFinancialRunnerHeartbeats;
  clock: (database: Parameters<typeof readFinancialRunnerHeartbeats>[0]) => Promise<Date>;
};

async function readAssessmentTime(
  database: Parameters<typeof readFinancialRunnerHeartbeats>[0]
): Promise<Date> {
  const result = await database.query("SELECT clock_timestamp() AS assessed_at");
  if (result.rows.length !== 1 ||
      !(result.rows[0].assessed_at instanceof Date) ||
      !Number.isFinite(result.rows[0].assessed_at.getTime())) {
    throw new Error("Invalid monitoring database clock");
  }
  return result.rows[0].assessed_at;
}

function unavailable(error: unknown) {
  const code = error && typeof error === "object" && "code" in error
    ? error.code : undefined;
  return {
    status: "unavailable" as const,
    reason: code === "42P01"
      ? "schema_unavailable" as const : "collection_failed" as const
  };
}

/**
 * Collects monitoring metadata only; never invokes financial workers.
 * Reads are sequential and independently handled, not one shared snapshot.
 * Database connections, read-only sessions and timeouts are caller-owned.
 * Both connections must refer to the same database environment.
 * Final assessment time comes from PostgreSQL, not the application clock.
 * A clock-read failure fails collection visibly; no local-clock fallback.
 * Default readers validate their returned records.
 * Invalid policy fails before any read. Assessment failures propagate.
 * Error messages and database connection details are not included in output.
 */
export async function collectFinancialMonitoringInputs(
  queueDatabase: Parameters<typeof readFinancialQueueHealth>[0],
  heartbeatDatabase: Parameters<typeof readFinancialRunnerHeartbeats>[0],
  policy: FinancialMonitoringPolicy,
  readers: Readers = {
    queue: readFinancialQueueHealth,
    heartbeats: readFinancialRunnerHeartbeats,
    clock: readAssessmentTime
  }
) {
  const absent = {status: "unavailable" as const, reason: "collection_failed" as const};
  assessFinancialMonitoring(absent, absent, policy);

  // Capture explicit policy before awaiting collection.
  const captured: FinancialMonitoringPolicy = {
    maxSnapshotAgeMs: policy.maxSnapshotAgeMs,
    maxHeartbeatAgeMs: policy.maxHeartbeatAgeMs,
    operations: Object.fromEntries(Object.entries(policy.operations).map(
      ([operation, settings]) => [operation, {...settings}]
    ))
  };
  let queue: MonitoringSource<QueueReport>;
  let heartbeats: MonitoringSource<HeartbeatReports>;
  try {
    queue = {status: "available", value: await readers.queue(queueDatabase)};
  } catch (error) {
    queue = unavailable(error);
  }
  try {
    heartbeats = {
      status: "available",
      value: await readers.heartbeats(heartbeatDatabase)
    };
  } catch (error) {
    heartbeats = unavailable(error);
  }
  // Database receipt timestamps must be assessed against the same database clock.
  // Clock-read failure propagates; never silently substitute the Node clock.
  const assessedAt = await readers.clock(heartbeatDatabase);
  assessFinancialMonitoring(queue, heartbeats, captured, assessedAt);
  return [queue, heartbeats, captured, assessedAt] as
    Parameters<typeof assessFinancialMonitoring>;
}

/** Existing assessment-only API; uses the same validated collection path. */
export async function collectFinancialMonitoring(
  ...args: Parameters<typeof collectFinancialMonitoringInputs>
) {
  return assessFinancialMonitoring(...await collectFinancialMonitoringInputs(...args));
}
