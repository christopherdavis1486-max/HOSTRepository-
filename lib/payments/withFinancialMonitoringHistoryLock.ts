import fs from "node:fs";
import path from "node:path";

/**
 * Exclusive local lock for cooperating callers in trusted storage.
 * Every caller for one history chain must use the same lock path.
 * No waiting, stale-lock expiry, automatic takeover or distributed locking.
 * A crash can leave the lock; inspect the owner before manual removal.
 * This does not verify that a supplied predecessor is the latest snapshot.
 */
export async function withFinancialMonitoringHistoryLock<T>(
  file: string, work: () => Promise<T>
): Promise<T> {
  const target = path.resolve(file);
  // EEXIST fails before work starts and preserves the existing lock.
  const descriptor = fs.openSync(target, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify({
      version: 1, pid: process.pid, createdAt: new Date().toISOString()
    }) + "\n", "utf8");
    fs.fsyncSync(descriptor);
    return await work();
  } finally {
    try { fs.closeSync(descriptor); }
    finally { fs.unlinkSync(target); }
  }
}
