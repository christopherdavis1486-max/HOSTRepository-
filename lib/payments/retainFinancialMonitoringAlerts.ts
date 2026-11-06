import { planFinancialMonitoringAlerts as plan } from "./planFinancialMonitoringAlerts";
import { compareFinancialMonitoringAlerts as compare } from "./compareFinancialMonitoringAlerts";

type Inputs = Parameters<typeof plan>;
export type FinancialMonitoringAlertHistory = {
  assessedAt: string;
  pending: {key: string; evidence: Inputs}[];
};

/**
 * Pure in-memory retention of active and unconfirmed monitoring conditions.
 * Evidence is retained until the existing comparison confirms clearing.
 * Reappearing retained conditions continue rather than opening again.
 * Cleared conditions are removed; a later recurrence opens again.
 * Returned state is detached from caller inputs.
 *
 * This state contains Date objects. It is not a JSON persistence format.
 * No delivery receipts, acknowledgements, reminders, scheduling or I/O.
 * Continuing does not establish that a notification was sent.
 */
export function retainFinancialMonitoringAlerts(
  previous: FinancialMonitoringAlertHistory | null,
  currentInputs: Inputs
) {
  const current = plan(...currentInputs);
  const pending = new Map<string, Inputs>();
  if (previous !== null) {
    if (!previous || typeof previous.assessedAt !== "string" ||
        !Number.isFinite(Date.parse(previous.assessedAt)) ||
        new Date(previous.assessedAt).toISOString() !== previous.assessedAt ||
        !Array.isArray(previous.pending)) {
      throw new Error("Invalid monitoring alert history");
    }
    if (Date.parse(current.assessedAt) < Date.parse(previous.assessedAt)) {
      throw new Error("Monitoring observations are out of order");
    }
    for (const entry of previous.pending) {
      if (!entry || typeof entry.key !== "string" ||
          !Array.isArray(entry.evidence) || pending.has(entry.key)) {
        throw new Error("Invalid retained monitoring condition");
      }
      const evidence = plan(...entry.evidence);
      if (Date.parse(evidence.assessedAt) > Date.parse(previous.assessedAt) ||
          !evidence.findings.some(finding => finding.key === entry.key)) {
        throw new Error("Invalid retained monitoring evidence");
      }
      pending.set(entry.key, entry.evidence);
    }
  }

  const transitions: ReturnType<typeof compare>["transitions"] = [];
  const next = new Map<string, Inputs>();
  const active = new Set(current.findings.map(finding => finding.key));
  for (const finding of current.findings) {
    transitions.push({
      status: pending.has(finding.key) ? "continuing" : "opened",
      finding: {...finding}
    });
    next.set(finding.key, currentInputs);
  }
  for (const [key, evidence] of pending) {
    if (active.has(key)) continue;
    const transition = compare(evidence, currentInputs).transitions.find(
      row => row.finding.key === key
    );
    if (!transition ||
        (transition.status !== "cleared" && transition.status !== "unconfirmed")) {
      throw new Error("Invalid retained monitoring transition");
    }
    transitions.push(transition);
    if (transition.status === "unconfirmed") next.set(key, evidence);
  }
  transitions.sort((a, b) => a.finding.key < b.finding.key ? -1 :
    a.finding.key > b.finding.key ? 1 : 0);
  const state: FinancialMonitoringAlertHistory = structuredClone({
    assessedAt: current.assessedAt,
    pending: [...next].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, evidence]) => ({key, evidence}))
  });
  return {
    scope: "monitoring_alert_retention_only" as const,
    current,
    transitions,
    state
  };
}
