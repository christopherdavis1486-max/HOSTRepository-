import { db } from "../db";
import {
  isHostTransferReconciliationEnabled,
  isTransferReversalReconciliationEnabled,
} from "../config/featureFlags";

function validateLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Invalid execution expiry batch limit");
  }
}

/** Expiry permits reconciliation only, never automatic execution retry.
 * Historical processing rows without execution timestamps remain untouched.
 */
export async function flagExpiredHostTransfers(limit = 100): Promise<string[]> {
  validateLimit(limit);
  if (!isHostTransferReconciliationEnabled()) return [];
  const result = await db.query(
    `WITH expired AS (
       SELECT id FROM host_transfer_entitlements
       WHERE status = 'transfer_processing' AND provider_transfer_id IS NULL
         AND execution_token IS NOT NULL AND execution_started_at IS NOT NULL
         AND execution_lease_expires_at < clock_timestamp()
       ORDER BY execution_lease_expires_at, id LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE host_transfer_entitlements e
     SET status = 'transfer_reconciliation_required',
         execution_lease_expires_at = NULL, updated_at = NOW()
     FROM expired WHERE e.id = expired.id RETURNING e.id`,
    [limit]
  );
  return result.rows.map(row => String(row.id));
}

export async function flagExpiredTransferReversals(limit = 100): Promise<string[]> {
  validateLimit(limit);
  if (!isTransferReversalReconciliationEnabled()) return [];
  const result = await db.query(
    `WITH expired AS (
       SELECT id FROM host_transfer_reversals
       WHERE status = 'reversal_processing' AND provider_reversal_id IS NULL
         AND execution_token IS NOT NULL AND execution_started_at IS NOT NULL
         AND execution_lease_expires_at < clock_timestamp()
       ORDER BY execution_lease_expires_at, id LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE host_transfer_reversals r
     SET status = 'reversal_reconciliation_required',
         execution_lease_expires_at = NULL
     FROM expired WHERE r.id = expired.id RETURNING r.id`,
    [limit]
  );
  return result.rows.map(row => String(row.id));
}
