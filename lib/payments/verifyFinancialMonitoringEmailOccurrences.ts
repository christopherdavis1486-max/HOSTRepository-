import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {inspectFinancialMonitoringHistoryChain as inspect}
  from "./inspectFinancialMonitoringHistoryChain";
import {trackFinancialMonitoringEmailOccurrences as track,
  type MonitoringEmailOccurrenceState as State}
  from "./trackFinancialMonitoringEmailOccurrences";
import {
  encodeBoundFinancialMonitoringHistory as encode,
  type FinancialMonitoringHistoryIdentity as Identity
} from "./financialMonitoringBoundHistoryCodec";

/**
 * Read-only complete-chain replay. Stop all writers first.
 * Requires the observations for every record, including cleared conditions.
 * Chain identity is the SHA256 of its first committed record.
 * Checks detect ordinary changes; this is not a transactional filesystem
 * snapshot, authentication, rollback protection or delivery authorisation.
 */
export function verifyFinancialMonitoringEmailOccurrences(
  directory: string,
  identity: Identity,
  expectedChainId: string,
  observations: Parameters<typeof track>[1][]
) {
  const first = inspect(directory, identity);
  if (!first.recordCount || !Array.isArray(observations) ||
      observations.length !== first.recordCount) {
    throw new Error("Complete nonempty monitoring replay required");
  }
  const captured: {file: string; bytes: Buffer}[] = [];
  let previousHead: string | null = null;
  let state: State | null = null;
  const transitions: {
    head: string;
    rows: ReturnType<typeof track>["transitions"];
  }[] = [];

  for (let index = 0; index < first.recordCount; index++) {
    const file = path.join(first.directory,
      String(index + 1).padStart(8, "0") + ".json");
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) {
      throw new Error("Invalid monitoring replay record");
    }
    const bytes = fs.readFileSync(file);
    if (bytes.length > 2 * 1024 * 1024) {
      throw new Error("Invalid monitoring replay record");
    }
    const head = crypto.createHash("sha256").update(bytes).digest("hex");
    if (index === 0 && head !== expectedChainId) {
      throw new Error("Monitoring replay chain identity mismatch");
    }
    const record = JSON.parse(bytes.toString("utf8"));
    if (record.version !== 1 || record.sequence !== index + 1 ||
        record.previousHead !== previousHead) {
      throw new Error("Monitoring replay linkage mismatch");
    }
    const result = track(state, observations[index], identity, expectedChainId, head);
    const expectedSnapshot = JSON.parse(encode(result.state.history, identity));
    // Compare JSON values structurally rather than relying on object key order.
    const canonical = (value: any): any =>
      Array.isArray(value) ? value.map(canonical) :
      value && typeof value === "object"
        ? Object.fromEntries(Object.keys(value).sort().map(key =>
            [key, canonical(value[key])]))
        : value;
    if (JSON.stringify(canonical(record.snapshot)) !==
        JSON.stringify(canonical(expectedSnapshot))) {
      throw new Error("Monitoring replay observations do not match committed snapshot");
    }
    state = result.state;
    transitions.push({head, rows: result.transitions});
    captured.push({file, bytes});
    previousHead = head;
  }

  if (previousHead !== first.head) {
    throw new Error("Monitoring chain changed during replay");
  }
  const last = inspect(first.directory, identity);
  if (last.head !== first.head || last.recordCount !== first.recordCount) {
    throw new Error("Monitoring chain changed during replay");
  }
  for (const entry of captured) {
    if (!fs.readFileSync(entry.file).equals(entry.bytes)) {
      throw new Error("Monitoring chain changed during replay");
    }
  }
  if (fs.existsSync(path.join(first.directory, ".chain.lock"))) {
    throw new Error("Monitoring chain changed during replay");
  }
  return {
    scope: "monitoring_email_occurrence_replay_only" as const,
    recordCount: first.recordCount,
    head: first.head,
    state: state!,
    transitions
  };
}
