import type { FinancialQueueHealth } from "./readFinancialQueueHealth";
import { financialQueueHealthOperations } from "./readFinancialQueueHealth";

export type QueueMonitoringPolicy = {
  maxSnapshotAgeMs: number;
  operations: Record<string, {
    expectedState: "running" | "paused" | "unknown";
    dueReviewAgeMs?: number;
  }>;
};

export type QueueMonitoringAssessment = {
  status: "observed" | "snapshot_unavailable";
  observedAt: string;
  assessedAt: string;
  reason?: "stale_snapshot" | "future_snapshot";
  operations: {
    operation: string;
    expectedState: "running" | "paused" | "unknown";
    disposition: "configuration_required" | "paused" | "observed";
    observations: (
      "due_metadata_requires_review" |
      "selected_metadata_without_feedback" |
      "unresolved_scheduling_metadata" |
      "backoff_in_progress"
    )[];
  }[];
};

const countFields = [
  "total", "due", "cooling", "selectedAwaitingFeedback", "selectedDue",
  "unresolved", "backingOff", "resolved", "eligible",
] as const;

function positiveMilliseconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function milliseconds(value: unknown): number {
  if (typeof value !== "string") throw new Error("Invalid monitoring timestamp");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("Invalid monitoring timestamp");
  }
  return parsed;
}

/**
 * Pure assessment of a validated scheduling snapshot and explicit operator policy.
 * No database, environment, worker, provider, timer or notification operations.
 * Expected runner state is supplied context, not a verified gate or heartbeat.
 * "observed" never means financially healthy or complete.
 */
export function assessFinancialQueueHealth(
  report: FinancialQueueHealth,
  policy: QueueMonitoringPolicy,
  now = new Date()
): QueueMonitoringAssessment {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Invalid monitoring assessment time");
  }
  if (!policy || !positiveMilliseconds(policy.maxSnapshotAgeMs) ||
      !policy.operations || typeof policy.operations !== "object" ||
      Array.isArray(policy.operations)) {
    throw new Error("Invalid queue monitoring policy");
  }
  const known = new Set<string>(financialQueueHealthOperations);
  for (const [operation, settings] of Object.entries(policy.operations)) {
    if (!known.has(operation) || !settings ||
        !["running", "paused", "unknown"].includes(settings.expectedState) ||
        (settings.dueReviewAgeMs !== undefined &&
          !positiveMilliseconds(settings.dueReviewAgeMs))) {
      throw new Error("Invalid operation monitoring policy");
    }
  }
  if (!report || report.scope !== "scheduling_metadata_only" ||
      !Array.isArray(report.rows) || report.rows.length !== known.size) {
    throw new Error("Invalid monitoring snapshot");
  }
  const observed = milliseconds(report.observedAt);
  const seen = new Set<string>();
  for (const row of report.rows) {
    if (!row || !known.has(row.operation) || seen.has(row.operation)) {
      throw new Error("Invalid monitoring snapshot operations");
    }
    seen.add(row.operation);
    for (const field of countFields) {
      if (typeof row[field] !== "string" || !/^(0|[1-9][0-9]*)$/.test(row[field])) {
        throw new Error("Invalid monitoring snapshot counts");
      }
    }
    const n = (field: typeof countFields[number]) => BigInt(row[field]);
    if (n("due") + n("cooling") !== n("total") ||
        n("selectedDue") > n("selectedAwaitingFeedback") ||
        n("selectedDue") > n("due") ||
        n("backingOff") > n("unresolved") ||
        n("backingOff") > n("cooling") ||
        n("selectedAwaitingFeedback") + n("unresolved") +
          n("resolved") + n("eligible") !== n("total") ||
        !Number.isInteger(row.maxReviewFailures) ||
        row.maxReviewFailures < 0 || row.maxReviewFailures > 16) {
      throw new Error("Inconsistent monitoring snapshot");
    }
    if ((n("due") === 0n) !== (row.oldestDueAt === null) ||
        (n("total") === 0n) !== (row.oldestReviewedAt === null)) {
      throw new Error("Inconsistent monitoring snapshot timestamps");
    }
    if (row.oldestDueAt !== null && milliseconds(row.oldestDueAt) > observed) {
      throw new Error("Invalid due monitoring timestamp");
    }
    if (row.oldestReviewedAt !== null &&
        milliseconds(row.oldestReviewedAt) > observed) {
      throw new Error("Invalid reviewed monitoring timestamp");
    }
  }

  const common = {observedAt:report.observedAt, assessedAt:now.toISOString()};
  if (observed > now.getTime()) {
    return {...common, status:"snapshot_unavailable", reason:"future_snapshot", operations:[]};
  }
  if (now.getTime() - observed > policy.maxSnapshotAgeMs) {
    return {...common, status:"snapshot_unavailable", reason:"stale_snapshot", operations:[]};
  }

  const operations = report.rows.map(row => {
    const settings = Object.prototype.hasOwnProperty.call(policy.operations, row.operation)
      ? policy.operations[row.operation] : undefined;
    const expectedState = settings?.expectedState ?? "unknown";
    const observations: QueueMonitoringAssessment["operations"][number]["observations"] = [];
    const configured = expectedState === "running" && settings?.dueReviewAgeMs !== undefined;
    if (BigInt(row.unresolved) > 0n) observations.push("unresolved_scheduling_metadata");
    if (BigInt(row.backingOff) > 0n) observations.push("backoff_in_progress");
    if (expectedState === "running" && BigInt(row.selectedDue) > 0n) {
      observations.push("selected_metadata_without_feedback");
    }
    if (configured && BigInt(row.due) > 0n && row.oldestDueAt !== null &&
        observed - milliseconds(row.oldestDueAt) >= settings!.dueReviewAgeMs!) {
      observations.push("due_metadata_requires_review");
    }
    return {
      operation:row.operation, expectedState,
      disposition: expectedState === "paused" ? "paused" as const :
        configured ? "observed" as const : "configuration_required" as const,
      observations,
    };
  });
  return {...common, status:"observed", operations};
}
