import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
 * Reads only. Stop all writers before inspection.
 * Refuses an existing lock; never removes locks, repairs files or advances.
 * Rechecks names and bytes to detect changes during inspection, but does not
 * provide a transactional filesystem snapshot or permission to resume writers.
 * Trusted local paths required; hashes are not authentication.
 */
export function inspectFinancialMonitoringHistoryChain(
  directory: string, expectedIdentity: Identity
) {
  const probe = JSON.parse(encode({
    assessedAt: new Date(0).toISOString(), pending: []
  }, expectedIdentity));
  const binding: Identity = probe.identity;
  const root = fs.realpathSync(directory);
  if (!fs.statSync(root).isDirectory()) {
    throw new Error("Monitoring chain directory required");
  }
  const lockFile = path.join(root, ".chain.lock");
  if (fs.existsSync(lockFile)) {
    throw new Error("Monitoring chain lock present; inspection refused");
  }
  const captured = new Map<string, Buffer>();
    const names = fs.readdirSync(root).sort();
    if (names.length > 10000 ||
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
      captured.set(wanted, bytes);
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

  if (fs.existsSync(lockFile) ||
      JSON.stringify(fs.readdirSync(root).sort()) !== JSON.stringify(names)) {
    throw new Error("Monitoring chain changed during inspection");
  }
  for (const [name, bytes] of captured) {
    const file = path.join(root, name);
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.size !== bytes.length ||
        !fs.readFileSync(file).equals(bytes)) {
      throw new Error("Monitoring chain changed during inspection");
    }
  }
  if (fs.existsSync(lockFile) ||
      JSON.stringify(fs.readdirSync(root).sort()) !== JSON.stringify(names)) {
    throw new Error("Monitoring chain changed during inspection");
  }
  return {
    directory: root, recordCount: names.length, head,
    file: names.length ? path.join(root, names[names.length - 1]) : null,
    state: previous
  };
}
