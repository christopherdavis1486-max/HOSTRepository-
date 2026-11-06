import { financialQueueHealthOperations } from "./readFinancialQueueHealth";

export type FinancialRunnerHeartbeatPolicy = {
  maxHeartbeatAgeMs: number;
  operations: Record<string, "running" | "paused" | "unknown">;
};

export type FinancialRunnerHeartbeat = {
  operation: string;
  reportedAt: string;
};

export type FinancialRunnerHeartbeatAssessment = {
  assessedAt: string;
  operations: {
    operation: string;
    expectedState: "running" | "paused" | "unknown";
    reportedAt: string | null;
    status: "recent" | "missing" | "stale" | "future" |
      "paused" | "configuration_required";
  }[];
};

/**
 * Pure assessment of caller-supplied heartbeat reports.
 * A recent report establishes reporting recency only, not worker progress,
 * enabled financial gates, successful dispatch or financial completion.
 * Paused state is explicit operator policy, never inferred from silence.
 */
export function assessFinancialRunnerHeartbeat(
  heartbeats: readonly FinancialRunnerHeartbeat[],
  policy: FinancialRunnerHeartbeatPolicy,
  now = new Date()
): FinancialRunnerHeartbeatAssessment {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Invalid heartbeat assessment time");
  }
  if (!policy || !Number.isSafeInteger(policy.maxHeartbeatAgeMs) ||
      policy.maxHeartbeatAgeMs <= 0 ||
      !policy.operations || typeof policy.operations !== "object" ||
      Array.isArray(policy.operations)) {
    throw new Error("Invalid heartbeat policy");
  }
  const known = new Set<string>(financialQueueHealthOperations);
  for (const [operation, state] of Object.entries(policy.operations)) {
    if (!known.has(operation) ||
        !["running", "paused", "unknown"].includes(state)) {
      throw new Error("Invalid heartbeat operation policy");
    }
  }
  if (!Array.isArray(heartbeats)) {
    throw new Error("Invalid heartbeat reports");
  }
  const reports = new Map<string, {reportedAt: string; time: number}>();
  for (const heartbeat of heartbeats) {
    if (!heartbeat || !known.has(heartbeat.operation) ||
        reports.has(heartbeat.operation) ||
        typeof heartbeat.reportedAt !== "string") {
      throw new Error("Invalid heartbeat report");
    }
    const time = Date.parse(heartbeat.reportedAt);
    if (!Number.isFinite(time) ||
        new Date(time).toISOString() !== heartbeat.reportedAt) {
      throw new Error("Invalid heartbeat timestamp");
    }
    reports.set(heartbeat.operation, {
      reportedAt: heartbeat.reportedAt, time
    });
  }
  return {
    assessedAt: now.toISOString(),
    operations: financialQueueHealthOperations.map(operation => {
      const expectedState = Object.prototype.hasOwnProperty.call(
        policy.operations, operation
      ) ? policy.operations[operation] : "unknown";
      const report = reports.get(operation);
      const status =
        expectedState === "paused" ? "paused" :
        expectedState === "unknown" ? "configuration_required" :
        !report ? "missing" :
        report.time > now.getTime() ? "future" :
        now.getTime() - report.time > policy.maxHeartbeatAgeMs ? "stale" :
        "recent";
      return {
        operation, expectedState,
        reportedAt: report?.reportedAt ?? null, status
      };
    })
  };
}
