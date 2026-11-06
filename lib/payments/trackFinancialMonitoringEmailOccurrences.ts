import {retainFinancialMonitoringAlerts as retain}
  from "./retainFinancialMonitoringAlerts";
import {financialMonitoringEmailOccurrenceId as identify}
  from "./financialMonitoringEmailOccurrenceId";
import type {FinancialMonitoringHistoryIdentity as Identity}
  from "./financialMonitoringBoundHistoryCodec";

type History = Parameters<typeof retain>[0];
type Occurrence = {key: string; openingHead: string; id: string};
export type MonitoringEmailOccurrenceState = {
  identity: Identity;
  chainId: string;
  lastHead: string;
  history: NonNullable<History>;
  active: Occurrence[];
};

/**
 * Pure lifecycle tracking through validated retention transitions.
 * Caller must verify committed record hashes, source identity, chain identity,
 * predecessor linkage and that observations produced the committed snapshot.
 * This function does not inspect files or authenticate supplied state.
 * No delivery eligibility, receipts, persistence or provider calls.
 */
export function trackFinancialMonitoringEmailOccurrences(
  previous: MonitoringEmailOccurrenceState | null,
  inputs: Parameters<typeof retain>[1],
  identity: Identity,
  chainId: string,
  committedHead: string
) {
  // Validate and capture context before deriving transitions.
  identify(identity, chainId, committedHead, "monitor:context");
  const binding = {
    environment: identity.environment,
    database: identity.database,
    schema: identity.schema
  };
  const prior = new Map<string, Occurrence>();
  if (previous !== null) {
    if (!previous || !previous.history || !Array.isArray(previous.active) ||
        previous.chainId !== chainId ||
        !previous.identity ||
        previous.identity.environment !== binding.environment ||
        previous.identity.database !== binding.database ||
        previous.identity.schema !== binding.schema) {
      throw new Error("Monitoring occurrence context mismatch");
    }
    identify(previous.identity, chainId, previous.lastHead, "monitor:context");
    if (previous.lastHead === committedHead) {
      throw new Error("Monitoring occurrence record already processed");
    }
    for (const row of previous.active) {
      if (!row || prior.has(row.key) ||
          row.id !== identify(binding, chainId, row.openingHead, row.key)) {
        throw new Error("Invalid monitoring occurrence state");
      }
      prior.set(row.key, {...row});
    }
    const keys = previous.history.pending.map(row => row.key).sort();
    if (JSON.stringify([...prior.keys()].sort()) !== JSON.stringify(keys)) {
      throw new Error("Monitoring occurrence evidence mismatch");
    }
  }

  const retained = retain(previous === null ? null : previous.history, inputs);
  const active = new Map<string, Occurrence>();
  const transitions = retained.transitions.map(row => {
    let occurrence = prior.get(row.finding.key);
    if (row.status === "opened") {
      if (occurrence) throw new Error("Unexpected existing occurrence");
      occurrence = {
        key: row.finding.key,
        openingHead: committedHead,
        id: identify(binding, chainId, committedHead, row.finding.key)
      };
    } else if (!occurrence) {
      throw new Error("Missing monitoring occurrence");
    }
    if (row.status !== "cleared") active.set(row.finding.key, occurrence);
    return {...row, finding: {...row.finding}, occurrence: {...occurrence}};
  });

  const state: MonitoringEmailOccurrenceState = structuredClone({
    identity: binding, chainId, lastHead: committedHead,
    history: retained.state,
    active: [...active.values()].sort((a,b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  });
  return {
    scope: "monitoring_email_occurrence_tracking_only" as const,
    transitions,
    state
  };
}
