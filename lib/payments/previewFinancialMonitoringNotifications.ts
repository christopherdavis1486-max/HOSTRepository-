import {retainFinancialMonitoringAlerts as retain}
  from "./retainFinancialMonitoringAlerts";

/**
 * Pure notification preview using validated retained monitoring evidence.
 * Opened and cleared conditions are candidates for operator review.
 * Continuing and unconfirmed conditions remain visible separately.
 * No delivery, receipts, recipients, reminders, persistence or financial work.
 * Replaying the same inputs repeats this preview; it does not deduplicate sends.
 */
export function previewFinancialMonitoringNotifications(
  previous: Parameters<typeof retain>[0],
  currentInputs: Parameters<typeof retain>[1]
) {
  const result = retain(previous, currentInputs);
  type Transition = typeof result.transitions[number];
  const copy = (row: Transition) => ({
    status: row.status,
    finding: {...row.finding}
  });

  return {
    scope: "monitoring_notification_preview_only" as const,
    assessedAt: result.current.assessedAt,
    deliveryAttempted: false as const,
    candidates: result.transitions
      .filter(row => row.status === "opened" || row.status === "cleared")
      .map(copy),
    continuing: result.transitions
      .filter(row => row.status === "continuing").map(copy),
    unconfirmed: result.transitions
      .filter(row => row.status === "unconfirmed").map(copy),
    clearingMeaning: "named_monitoring_condition_only" as const,
    state: result.state
  };
}
