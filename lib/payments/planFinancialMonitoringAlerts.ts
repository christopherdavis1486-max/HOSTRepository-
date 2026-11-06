import { assessFinancialMonitoring } from "./assessFinancialMonitoring";

type Inputs = Parameters<typeof assessFinancialMonitoring>;
export type FinancialMonitoringFinding = {
  key: string;
  operation: string | null;
  code: string;
  severity: "warning" | "information";
};

/**
 * Pure alert planning from validated monitoring sources and explicit policy.
 * Stable keys identify conditions, not financial jobs or delivery attempts.
 * No notifications, persistence, scheduling, worker dispatch or automatic recovery.
 * Unavailable sources produce source-level findings rather than ten duplicates.
 * Recent reporting and callback return never establish financial completion.
 */
export function planFinancialMonitoringAlerts(
  queue: Inputs[0],
  heartbeats: Inputs[1],
  policy: Inputs[2],
  now = new Date()
) {
  const assessment = assessFinancialMonitoring(queue, heartbeats, policy, now);
  const findings: FinancialMonitoringFinding[] = [];
  const seen = new Set<string>();
  function add(
    operation: string | null,
    code: string,
    severity: FinancialMonitoringFinding["severity"] = "warning"
  ) {
    const key = (operation ?? "monitor") + ":" + code;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({key, operation, code, severity});
  }

  if (assessment.queue.status === "unavailable") {
    add(null, "queue_" + assessment.queue.reason);
  } else if (assessment.queue.assessment.status === "snapshot_unavailable") {
    add(null, "queue_" + assessment.queue.assessment.reason);
  }
  if (assessment.heartbeat.status === "unavailable") {
    add(null, "heartbeat_" + assessment.heartbeat.reason);
  }

  for (const row of assessment.operations) {
    // Unknown operator intent is visible even when collection is unavailable.
    if (row.expectedState === "unknown") {
      add(row.operation, "configuration_required");
    }
    if (row.queue.status === "observed") {
      if (row.queue.assessment.disposition === "configuration_required") {
        add(row.operation, "configuration_required");
      }
      for (const observation of row.queue.assessment.observations) {
        add(row.operation, observation,
          observation === "backoff_in_progress" ? "information" : "warning");
      }
    }
    if (row.heartbeat.status !== "unavailable") {
      switch (row.heartbeat.status) {
        case "configuration_required":
          add(row.operation, "configuration_required");
          break;
        case "missing":
        case "stale":
        case "future":
          add(row.operation, "heartbeat_" + row.heartbeat.status);
          break;
      }
      // Pause suppresses freshness conclusions, not recorded callback failures.
      if (row.heartbeat.outcome === "threw") {
        add(row.operation, "runner_threw");
      }
    }
  }

  findings.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return {
    scope: "monitoring_alert_plan_only" as const,
    assessedAt: assessment.assessedAt,
    assessment,
    findings
  };
}
