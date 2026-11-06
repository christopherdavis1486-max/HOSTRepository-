import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  encodeFinancialMonitoringEmailOccurrences as encode,
  decodeFinancialMonitoringEmailOccurrences as decode
} from "./financialMonitoringEmailOccurrenceCodec";
import type {FinancialMonitoringHistoryIdentity as Identity}
  from "./financialMonitoringBoundHistoryCodec";
import type {MonitoringEmailOccurrenceState as State}
  from "./trackFinancialMonitoringEmailOccurrences";

/**
 * Explicit local immutable snapshots in a caller-owned trusted directory.
 * Save publishes a fully written, synced file using an exclusive hard link.
 * Existing snapshots are never replaced. Parent directory must already exist.
 * No automatic latest-file selection, retention deletion or scheduling.
 * File sync does not establish power-loss durability of directory metadata.
 * A process crash may leave an unpublished temporary file; it is never loaded
 * automatically. Caller owns environment separation and directory permissions.
 */
export function saveFinancialMonitoringEmailOccurrences(file: string, state: State): void {
  const text = encode(state);
  const target = path.resolve(file);
  const temporary = path.join(path.dirname(target),
    ".host-occurrence-" + crypto.randomUUID() + ".tmp");
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
export function loadFinancialMonitoringEmailOccurrences(file: string, expected: Identity, chainId: string): State {
  const target = path.resolve(file);
  const info = fs.lstatSync(target);
  if (!info.isFile() || info.size > 2 * 1024 * 1024) {
    throw new Error("Invalid alert history snapshot file");
  }
  const descriptor = fs.openSync(target, "r");
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > 2 * 1024 * 1024) {
      throw new Error("Invalid alert history snapshot file");
    }
    return decode(fs.readFileSync(descriptor, "utf8"), expected, chainId);
  } finally {
    fs.closeSync(descriptor);
  }
}

// Identity matching is not authentication. Callers must verify the actual
// database source separately; identifiers contain no credentials.

// Occurrence metadata validation does not verify committed-chain membership.
// Use a dedicated occurrence directory, outside the monitoring history chain.
