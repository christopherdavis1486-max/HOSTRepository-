import {
  planFinancialMonitoringAlerts,
  type FinancialMonitoringFinding
} from "./planFinancialMonitoringAlerts";

type Inputs = Parameters<typeof planFinancialMonitoringAlerts>;
type Plan = ReturnType<typeof planFinancialMonitoringAlerts>;

function canConfirmCleared(
  finding: FinancialMonitoringFinding,
  current: Plan,
  inputs: Inputs
): boolean {
  if (finding.operation === null) {
    if (finding.code.startsWith("queue_")) {
      return current.assessment.queue.status === "available" &&
        current.assessment.queue.assessment.status === "observed";
    }
    if (finding.code.startsWith("heartbeat_")) {
      return current.assessment.heartbeat.status === "available";
    }
    return false;
  }
  const row = current.assessment.operations.find(
    value => value.operation === finding.operation
  )!;
  if (finding.code === "configuration_required") {
    const settings = inputs[2].operations[finding.operation];
    return settings?.expectedState === "paused" ||
      (settings?.expectedState === "running" && settings.dueReviewAgeMs !== undefined);
  }
  if (finding.code === "runner_threw") {
    return row.heartbeat.status === "recent" && row.heartbeat.outcome === "returned";
  }
  if (finding.code.startsWith("heartbeat_")) {
    return row.heartbeat.status === "recent";
  }
  if (row.queue.status !== "observed") return false;
  if (finding.code === "due_metadata_requires_review" ||
      finding.code === "selected_metadata_without_feedback") {
    return row.queue.assessment.disposition === "observed";
  }
  return true;
}

/**
 * Pure comparison of two validated monitoring observations.
 * Continuing conditions are distinct from newly opened conditions.
 * Missing evidence, pause and unknown policy do not establish recovery.
 * "cleared" applies only to the named monitoring condition, never financial work.
 * Caller owns history retention. Keep unconfirmed conditions until later evidence.
 * No delivery, acknowledgement, persistence, timers or financial retries.
 */
export function compareFinancialMonitoringAlerts(
  previousInputs: Inputs | null,
  currentInputs: Inputs
) {
  const previous = previousInputs === null
    ? null : planFinancialMonitoringAlerts(...previousInputs);
  const current = planFinancialMonitoringAlerts(...currentInputs);
  if (previous && Date.parse(current.assessedAt) < Date.parse(previous.assessedAt)) {
    throw new Error("Monitoring observations are out of order");
  }
  const prior = new Map(previous?.findings.map(row => [row.key, row]) ?? []);
  const active = new Map(current.findings.map(row => [row.key, row]));
  const transitions: {
    status: "opened" | "continuing" | "cleared" | "unconfirmed";
    finding: FinancialMonitoringFinding;
  }[] = [];
  for (const finding of current.findings) {
    transitions.push({
      status: prior.has(finding.key) ? "continuing" : "opened",
      finding: {...finding}
    });
  }
  for (const finding of prior.values()) {
    if (!active.has(finding.key)) {
      transitions.push({
        status: canConfirmCleared(finding, current, currentInputs)
          ? "cleared" : "unconfirmed",
        finding: {...finding}
      });
    }
  }
  transitions.sort((a, b) => a.finding.key < b.finding.key ? -1 :
    a.finding.key > b.finding.key ? 1 : 0);
  return {
    scope: "monitoring_alert_comparison_only" as const,
    previousAssessedAt: previous?.assessedAt ?? null,
    assessedAt: current.assessedAt,
    current,
    transitions
  };
}
