import {
  encodeBoundFinancialMonitoringHistory as encodeHistory,
  decodeBoundFinancialMonitoringHistory as decodeHistory,
  type FinancialMonitoringHistoryIdentity as Identity
} from "./financialMonitoringBoundHistoryCodec";
import {financialMonitoringEmailOccurrenceId as identify}
  from "./financialMonitoringEmailOccurrenceId";
import type {MonitoringEmailOccurrenceState as State}
  from "./trackFinancialMonitoringEmailOccurrences";

const maxBytes = 2 * 1024 * 1024;

function exact(value: unknown, keys: string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error("Invalid monitoring occurrence format");
  }
}

/**
 * Validates local occurrence metadata and retained evidence.
 * Does not prove committed-chain membership, opening history or authenticity.
 * No file access, delivery receipts or provider calls.
 */
export function decodeFinancialMonitoringEmailOccurrences(
  text: string, expectedIdentity: Identity, expectedChainId: string
): State {
  identify(expectedIdentity, expectedChainId, "0".repeat(64), "monitor:context");
  if (typeof text !== "string" ||
      Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error("Invalid monitoring occurrence size");
  }
  const envelope = JSON.parse(text);
  exact(envelope, ["version", "chainId", "lastHead", "snapshot", "active"]);
  if (envelope.version !== 1 || envelope.chainId !== expectedChainId) {
    throw new Error("Monitoring occurrence context mismatch");
  }
  identify(expectedIdentity, expectedChainId, envelope.lastHead, "monitor:context");
  const history = decodeHistory(JSON.stringify(envelope.snapshot), expectedIdentity);
  if (!Array.isArray(envelope.active) || envelope.active.length > 256) {
    throw new Error("Invalid monitoring occurrence list");
  }
  const seen = new Set<string>();
  const active = envelope.active.map((row: unknown) => {
    exact(row, ["key", "openingHead", "id"]);
    if (seen.has(row.key) ||
        row.id !== identify(expectedIdentity, expectedChainId,
          row.openingHead, row.key)) {
      throw new Error("Invalid monitoring occurrence identity");
    }
    seen.add(row.key);
    return {key: row.key as string, openingHead: row.openingHead as string,
      id: row.id as string};
  });
  const pending = history.pending.map(row => row.key).sort();
  if (JSON.stringify([...seen].sort()) !== JSON.stringify(pending)) {
    throw new Error("Monitoring occurrence evidence mismatch");
  }
  active.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return {
    identity: {
      environment: expectedIdentity.environment,
      database: expectedIdentity.database,
      schema: expectedIdentity.schema
    },
    chainId: expectedChainId,
    lastHead: envelope.lastHead,
    history, active
  };
}

export function encodeFinancialMonitoringEmailOccurrences(state: State): string {
  exact(state, ["identity", "chainId", "lastHead", "history", "active"]);
  const text = JSON.stringify({
    version: 1,
    chainId: state.chainId,
    lastHead: state.lastHead,
    snapshot: JSON.parse(encodeHistory(state.history, state.identity)),
    active: state.active
  }) + "\n";
  // Reuse the same validation path as loading.
  decodeFinancialMonitoringEmailOccurrences(text, state.identity, state.chainId);
  return text;
}
