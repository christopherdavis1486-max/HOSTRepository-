import {
  assessFinancialQueueHealth,
  type QueueMonitoringPolicy
} from "./assessFinancialQueueHealth";
import { assessFinancialRunnerHeartbeat } from "./assessFinancialRunnerHeartbeat";
import { financialQueueHealthOperations } from "./readFinancialQueueHealth";
import type { FinancialQueueHealth } from "./readFinancialQueueHealth";
import type { FinancialRunnerHeartbeatRecord } from "./financialRunnerHeartbeatStore";

export type MonitoringSource<T> =
  | {status: "available"; value: T}
  | {status: "unavailable"; reason: "collection_failed" | "schema_unavailable"};

export type FinancialMonitoringPolicy = QueueMonitoringPolicy & {
  maxHeartbeatAgeMs: number;
};

function validateSource<T>(source: MonitoringSource<T>): void {
  if (!source || !["available", "unavailable"].includes(source.status) ||
      (source.status === "unavailable" &&
       !["collection_failed", "schema_unavailable"].includes(source.reason))) {
    throw new Error("Invalid monitoring source");
  }
}

function time(value: unknown): number {
  if (typeof value !== "string") throw new Error("Invalid heartbeat metadata");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("Invalid heartbeat metadata");
  }
  return parsed;
}

/**
 * Pure composition of independently collected monitoring sources.
 * Operator policy is explicit and shared by both assessments.
 * Collection failures remain unavailable, never fabricated empty reports.
 * Sources need not describe the same database snapshot.
 * Recency and callback return never establish financial success.
 */
export function assessFinancialMonitoring(
  queueSource: MonitoringSource<FinancialQueueHealth>,
  heartbeatSource: MonitoringSource<readonly FinancialRunnerHeartbeatRecord[]>,
  policy: FinancialMonitoringPolicy,
  now = new Date()
) {
  validateSource(queueSource);
  validateSource(heartbeatSource);
  if (!policy) throw new Error("Invalid monitoring policy");

  // Validate policy even when either source is unavailable.
  const heartbeatPolicy = {
    maxHeartbeatAgeMs: policy.maxHeartbeatAgeMs,
    operations: Object.fromEntries(Object.entries(policy.operations ?? {}).map(
      ([operation, settings]) => [operation, settings?.expectedState]
    ))
  };
  const emptyQueue: FinancialQueueHealth = {
    scope: "scheduling_metadata_only",
    observedAt: now instanceof Date && Number.isFinite(now.getTime())
      ? now.toISOString() : "",
    rows: financialQueueHealthOperations.map(operation => ({
      operation, total: "0", due: "0", cooling: "0",
      selectedAwaitingFeedback: "0", selectedDue: "0",
      unresolved: "0", backingOff: "0", resolved: "0", eligible: "0",
      maxReviewFailures: 0, oldestDueAt: null, oldestReviewedAt: null
    }))
  };
  const assessedQueue = assessFinancialQueueHealth(
    queueSource.status === "available" ? queueSource.value : emptyQueue,
    policy, now
  );
  const records = heartbeatSource.status === "available" ? heartbeatSource.value : [];
  if (!Array.isArray(records)) throw new Error("Invalid heartbeat metadata");
  for (const record of records) {
    if (!record ||
        typeof record.runToken !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.runToken) ||
        !["started", "returned", "threw"].includes(record.outcome)) {
      throw new Error("Invalid heartbeat metadata");
    }
    const started = time(record.startedAt);
    const reported = time(record.reportedAt);
    if (reported < started ||
        (record.outcome === "started" ? record.finishedAt !== null :
          record.finishedAt === null ||
          time(record.finishedAt) < started ||
          record.finishedAt !== record.reportedAt)) {
      throw new Error("Inconsistent heartbeat metadata");
    }
  }
  const assessedHeartbeat = assessFinancialRunnerHeartbeat(records, heartbeatPolicy, now);
  const byOperation = new Map(records.map(record => [record.operation, record]));

  const queue = queueSource.status === "available"
    ? {status: "available" as const, assessment: assessedQueue}
    : {status: "unavailable" as const, reason: queueSource.reason};
  const heartbeat = heartbeatSource.status === "available"
    ? {status: "available" as const, assessment: assessedHeartbeat}
    : {status: "unavailable" as const, reason: heartbeatSource.reason};

  return {
    scope: "monitoring_metadata_only" as const,
    assessedAt: now.toISOString(),
    queue,
    heartbeat,
    operations: assessedHeartbeat.operations.map(item => {
      const record = byOperation.get(item.operation);
      return {
        operation: item.operation,
        expectedState: item.expectedState,
        queue: queueSource.status === "unavailable"
          ? {status: "unavailable" as const, reason: queueSource.reason}
          : assessedQueue.status === "snapshot_unavailable"
            ? {status: "unavailable" as const, reason: assessedQueue.reason!}
            : {
                status: "observed" as const,
                assessment: assessedQueue.operations.find(
                  row => row.operation === item.operation
                )!
              },
        heartbeat: heartbeatSource.status === "unavailable"
          ? {status: "unavailable" as const, reason: heartbeatSource.reason}
          : {
              status: item.status,
              reportedAt: item.reportedAt,
              outcome: record?.outcome ?? null,
              startedAt: record?.startedAt ?? null,
              finishedAt: record?.finishedAt ?? null
            }
      };
    })
  };
}
