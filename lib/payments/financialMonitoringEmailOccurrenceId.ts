import crypto from "node:crypto";
import {
  encodeBoundFinancialMonitoringHistory as encode,
  type FinancialMonitoringHistoryIdentity as Identity
} from "./financialMonitoringBoundHistoryCodec";

/**
 * Deterministic occurrence identity only; no I/O or delivery.
 * Caller must verify the chain identifier, committed opening record,
 * and opened condition against validated monitoring history.
 * Hashes provide identification, not authentication or proof of opening.
 */
export function financialMonitoringEmailOccurrenceId(
  identity: Identity,
  chainId: string,
  openingHead: string,
  conditionKey: string
): string {
  const binding: Identity = JSON.parse(encode({
    assessedAt: new Date(0).toISOString(), pending: []
  }, identity)).identity;

  if (typeof chainId !== "string" ||
      !/^[a-f0-9]{64}$/.test(chainId) ||
      typeof openingHead !== "string" ||
      !/^[a-f0-9]{64}$/.test(openingHead) ||
      typeof conditionKey !== "string" ||
      !/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/.test(conditionKey) ||
      conditionKey.length > 256) {
    throw new Error("Invalid monitoring email occurrence identity");
  }

  const canonical = JSON.stringify([
    "financial-monitoring-email-occurrence", 1,
    binding.environment, binding.database, binding.schema,
    chainId, openingHead, conditionKey
  ]);
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}
