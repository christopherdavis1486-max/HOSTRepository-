import {
  encodeFinancialMonitoringAlertHistory as encode,
  decodeFinancialMonitoringAlertHistory as decode
} from "./financialMonitoringAlertHistoryCodec";
import type { FinancialMonitoringAlertHistory as History }
  from "./retainFinancialMonitoringAlerts";

export type FinancialMonitoringHistoryIdentity = {
  environment: string;
  database: string;
  schema: string;
};

const fields = ["environment", "database", "schema"] as const;
const maxBytes = 1024 * 1024;

function identity(value: unknown): FinancialMonitoringHistoryIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid monitoring history identity");
  }
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== fields.length ||
      fields.some(field => typeof row[field] !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(row[field] as string))) {
    throw new Error("Invalid monitoring history identity");
  }
  return {
    environment: row.environment as string,
    database: row.database as string,
    schema: row.schema as string
  };
}

/**
 * Explicit identity matching, not authentication.
 * The caller must verify these identifiers against its actual data source.
 * Legacy unbound snapshots are deliberately not accepted here.
 */
export function encodeBoundFinancialMonitoringHistory(
  state: History, expected: FinancialMonitoringHistoryIdentity
): string {
  const binding = identity(expected);
  const validated = JSON.parse(encode(state));
  const text = JSON.stringify({
    version: 2, identity: binding, history: validated
  }) + "\n";
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error("Bound monitoring history exceeds size limit");
  }
  return text;
}

export function decodeBoundFinancialMonitoringHistory(
  text: string, expected: FinancialMonitoringHistoryIdentity
): History {
  const wanted = identity(expected);
  if (typeof text !== "string" ||
      Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error("Invalid bound monitoring history size");
  }
  const envelope = JSON.parse(text);
  if (!envelope || envelope.version !== 2) {
    throw new Error("Bound monitoring history required");
  }
  const stored = identity(envelope.identity);
  if (fields.some(field => stored[field] !== wanted[field])) {
    throw new Error("Monitoring history identity mismatch");
  }
  return decode(JSON.stringify(envelope.history));
}
