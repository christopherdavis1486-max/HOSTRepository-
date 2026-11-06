import {
  retainFinancialMonitoringAlerts as retain,
  type FinancialMonitoringAlertHistory as History
} from "./retainFinancialMonitoringAlerts";

const maxBytes = 1024 * 1024;
const maxConditions = 256;

function date(value: unknown): Date {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) {
    throw new Error("Invalid alert history timestamp");
  }
  return new Date(value);
}

function validate(state: History): void {
  if (!state || typeof state !== "object" ||
      !Array.isArray(state.pending) || state.pending.length > maxConditions) {
    throw new Error("Invalid alert history state");
  }
  const assessedAt = date(state.assessedAt);
  for (const entry of state.pending) {
    if (!entry || !Array.isArray(entry.evidence) ||
        entry.evidence.length !== 4 ||
        !(entry.evidence[3] instanceof Date) ||
        !Number.isFinite(entry.evidence[3].getTime())) {
      throw new Error("Invalid alert history evidence");
    }
  }
  // Reuse reducer validation of every retained condition and its evidence.
  // The result is discarded; serialization never advances the retained state.
  if (state.pending.length) {
    const evidence = state.pending[0].evidence;
    retain(state, [evidence[0], evidence[1], evidence[2], assessedAt]);
  }
}

/**
 * Versioned, bounded JSON encoding only. No files or database access.
 * Parsing validates all retained evidence before returning usable state.
 * Validation does not authenticate state or bind it to an environment.
 * Callers must supply trusted storage and separate states by environment.
 */
export function encodeFinancialMonitoringAlertHistory(state: History): string {
  validate(state);
  const text = JSON.stringify({version: 1, state}) + "\n";
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error("Alert history exceeds size limit");
  }
  return text;
}

export function decodeFinancialMonitoringAlertHistory(text: string): History {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error("Invalid alert history input size");
  }
  const envelope = JSON.parse(text);
  if (!envelope || envelope.version !== 1 ||
      !envelope.state || typeof envelope.state !== "object" ||
      !Array.isArray(envelope.state.pending) ||
      envelope.state.pending.length > maxConditions) {
    throw new Error("Invalid alert history format");
  }
  const state = envelope.state;
  date(state.assessedAt);
  for (const entry of state.pending) {
    if (!entry || !Array.isArray(entry.evidence) || entry.evidence.length !== 4) {
      throw new Error("Invalid alert history evidence");
    }
    entry.evidence[3] = date(entry.evidence[3]);
  }
  validate(state);
  return state;
}
