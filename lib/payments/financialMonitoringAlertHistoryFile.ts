import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  encodeFinancialMonitoringAlertHistory as encode,
  decodeFinancialMonitoringAlertHistory as decode
} from "./financialMonitoringAlertHistoryCodec";
import type { FinancialMonitoringAlertHistory as History } from "./retainFinancialMonitoringAlerts";

/**
 * Explicit local immutable snapshots in a caller-owned trusted directory.
 * Save publishes a fully written, synced file using an exclusive hard link.
 * Existing snapshots are never replaced. Parent directory must already exist.
 * No automatic latest-file selection, retention deletion or scheduling.
 * File sync does not establish power-loss durability of directory metadata.
 * A process crash may leave an unpublished temporary file; it is never loaded
 * automatically. Caller owns environment separation and directory permissions.
 */
export function saveFinancialMonitoringAlertHistory(file: string, state: History): void {
  const text = encode(state);
  const target = path.resolve(file);
  const temporary = path.join(path.dirname(target),
    ".host-alert-" + crypto.randomUUID() + ".tmp");
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    created = true;
    fs.writeFileSync(descriptor, text, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    // Exclusive publication: EEXIST preserves an existing snapshot.
    fs.linkSync(temporary, target);
  } finally {
    try {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    } finally {
      if (created) fs.unlinkSync(temporary);
    }
  }
}

/**
 * Missing files, invalid state and I/O errors propagate.
 * Never substitutes an empty history after a failed load.
 * Trusted directory required; this is not a hostile-path sandbox.
 */
export function loadFinancialMonitoringAlertHistory(file: string): History {
  const target = path.resolve(file);
  const info = fs.lstatSync(target);
  if (!info.isFile() || info.size > 1024 * 1024) {
    throw new Error("Invalid alert history snapshot file");
  }
  const descriptor = fs.openSync(target, "r");
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > 1024 * 1024) {
      throw new Error("Invalid alert history snapshot file");
    }
    return decode(fs.readFileSync(descriptor, "utf8"));
  } finally {
    fs.closeSync(descriptor);
  }
}
