import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {withFinancialMonitoringHistoryLock as lock}
  from "./withFinancialMonitoringHistoryLock";
import {
  encodeBoundFinancialMonitoringHistory as encode,
  decodeBoundFinancialMonitoringHistory as decode,
  type FinancialMonitoringHistoryIdentity as Identity
} from "./financialMonitoringBoundHistoryCodec";
import type {FinancialMonitoringAlertHistory as History}
  from "./retainFinancialMonitoringAlerts";

const sha = (bytes: Buffer) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

/**
 * Caller-owned trusted local directory, dedicated to one history chain.
 * Immutable numbered records contain their predecessor hash and bound history.
 * No automatic repair, orphan deletion, lock takeover or power-loss guarantee.
 * All writers must use this API and the same real directory.
 */
export async function advanceFinancialMonitoringHistoryChain(
  directory: string,
  expectedIdentity: Identity,
  expectedHead: string | null,
  work: (previous: History | null) => Promise<History>
) {
  // Capture and validate identity before any asynchronous work.
  const probe = JSON.parse(encode({
    assessedAt: new Date(0).toISOString(), pending: []
  }, expectedIdentity));
  const binding: Identity = probe.identity;
  if (expectedHead !== null &&
      (typeof expectedHead !== "string" || !/^[a-f0-9]{64}$/.test(expectedHead))) {
    throw new Error("Invalid expected monitoring chain head");
  }
  const root = fs.realpathSync(directory);
  if (!fs.statSync(root).isDirectory()) {
    throw new Error("Monitoring chain directory required");
  }
  return lock(path.join(root, ".chain.lock"), async () => {
    const names = fs.readdirSync(root).filter(name => name !== ".chain.lock").sort();
    if (names.length >= 10000 ||
        names.some(name => !/^[0-9]{8}\.json$/.test(name))) {
      throw new Error("Unexpected monitoring chain entries");
    }
    let head: string | null = null;
    let previous: History | null = null;
    for (let index = 0; index < names.length; index++) {
      const wanted = String(index + 1).padStart(8, "0") + ".json";
      if (names[index] !== wanted) throw new Error("Monitoring chain sequence gap");
      const file = path.join(root, wanted);
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.size > 2 * 1024 * 1024) {
        throw new Error("Invalid monitoring chain record file");
      }
      const bytes = fs.readFileSync(file);
      if (bytes.length > 2 * 1024 * 1024) {
        throw new Error("Monitoring chain record exceeds size limit");
      }
      const record = JSON.parse(bytes.toString("utf8"));
      if (!record || record.version !== 1 || record.sequence !== index + 1 ||
          record.previousHead !== head) {
        throw new Error("Invalid monitoring chain linkage");
      }
      const state = decode(JSON.stringify(record.snapshot), binding);
      if (previous && state.assessedAt < previous.assessedAt) {
        throw new Error("Monitoring chain time moved backwards");
      }
      previous = state;
      head = sha(bytes);
    }
    if (head !== expectedHead) {
      throw new Error("Monitoring chain head changed");
    }
    const previousTime = previous?.assessedAt;
    const next = await work(previous === null ? null : structuredClone(previous));
    const snapshot = JSON.parse(encode(next, binding));
    if (previousTime && snapshot.history.state.assessedAt < previousTime) {
      throw new Error("Monitoring chain time moved backwards");
    }
    const sequence = names.length + 1;
    const bytes = Buffer.from(JSON.stringify({
      version: 1, sequence, previousHead: head, snapshot
    }) + "\n", "utf8");
    if (bytes.length > 2 * 1024 * 1024) {
      throw new Error("Monitoring chain record exceeds size limit");
    }
    const file = path.join(root, String(sequence).padStart(8, "0") + ".json");
    const temporary = path.join(root, ".record-" + crypto.randomUUID() + ".tmp");
    let descriptor: number | undefined;
    let created = false;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      created = true;
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.linkSync(temporary, file);
    } finally {
      try {
        if (descriptor !== undefined) fs.closeSync(descriptor);
      } finally {
        if (created) fs.unlinkSync(temporary);
      }
    }
    return {
      head: sha(bytes), file,
      state: decode(JSON.stringify(snapshot), binding)
    };
  });
}
