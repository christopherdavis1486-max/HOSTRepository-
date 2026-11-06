import { db, withTransaction } from "../db";
import { transferFinancialEligibility, withHostTransferProviderLock } from "./withHostTransferProviderLock";
export { withHostTransferProviderLock, type HostTransferExecutionSnapshot } from "./withHostTransferProviderLock";
import crypto from "crypto";
import type { PoolClient } from "pg";
import type Stripe from "stripe";
import { stripe } from "../payments/stripeClient";
import { isHostTransferExecutionEnabled } from "../config/featureFlags";

/**
 * New for Batch 9 — used ONLY for separate_charges_delayed_v1 bookings.
 * The existing `payouts` table is preserved, untouched, as the permanent
 * legacy record for destination_charge_legacy bookings; this is a
 * genuinely separate table, never written to by legacy code and never
 * read by it either.
 *
 * CRITICAL: createEntitlement() only ever INSERTs a local row — it never
 * calls Stripe. attemptRelease() is the one function that WOULD call
 * stripe.transfers.create(), and it refuses to do so unless
 * isHostTransferExecutionEnabled() returns true — checked first, before
 * any other logic, so there is no code path that reaches a real Stripe
 * call while the flag is off. This flag is independent of the other two;
 * it is never inferred from them.
 */

export type EntitlementStatus = "entitled" | "release_due" | "transfer_claimed" | "transfer_created" | "transfer_failed" | "cancelled_before_transfer" | "transfer_processing" | "transfer_reconciliation_required" | "cancellation_settlement_required";

/** Called only after a real payment_attempts row shows status='succeeded'
 *  — never at charge time, never automatically as a side effect of a
 *  charge (unlike the legacy destination-charge path this deliberately
 *  does NOT replicate). */
export async function createEntitlement(input: {
  bookingId: string; hostId: string; amountMinor: number; taxAmountMinor: number | null;
  currency: string; scheduledReleaseAt: Date;
}, client?: PoolClient) {
  const idempotencyKey = crypto.createHash("sha256").update(`host-transfer-entitlement:${input.bookingId}`).digest("hex");
  const result = await (client ?? db).query(
    `INSERT INTO host_transfer_entitlements (booking_id, host_id, amount_minor, tax_amount_minor, currency, status, scheduled_release_at, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, 'entitled', $6, $7)
     ON CONFLICT (booking_id) DO NOTHING
     RETURNING id`,
    [input.bookingId, input.hostId, input.amountMinor, input.taxAmountMinor, input.currency, input.scheduledReleaseAt, idempotencyKey]
  );
  return result.rows[0]?.id ?? null;
}

/** Finds entitlements whose release condition is genuinely met: past their
 *  release time, no cancellation, no qualifying refund, no open dispute.
 *  Read-only — does not itself claim or transfer anything. */
export async function findReleaseDueEntitlementIds(): Promise<string[]> {
  const result = await db.query(
    `SELECT hte.id FROM host_transfer_entitlements hte
     JOIN bookings b ON b.id = hte.booking_id
     WHERE hte.status = 'entitled'
       AND hte.scheduled_release_at <= NOW()
       AND b.status NOT IN ('cancelled', 'disputed')
       AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.booking_id = hte.booking_id AND r.status = 'succeeded')
     LIMIT 200`
  );
  return result.rows.map((r) => r.id);
}

/** Atomic claim — a single conditional UPDATE, the same pattern already
 *  proven correct for booking creation's advisory locking elsewhere in
 *  this codebase. Only one concurrent worker can ever successfully claim
 *  a given row. */
export async function claimEntitlement(entitlementId: string, workerId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE host_transfer_entitlements
     SET status = 'transfer_claimed', claimed_at = NOW(), claimed_by_worker_id = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'entitled'
       AND EXISTS (
         SELECT 1 FROM bookings b
         WHERE b.id = host_transfer_entitlements.booking_id
           AND b.status = 'confirmed'
       )
     RETURNING id`,
    [entitlementId, workerId]
  );
  return result.rows.length > 0;
}

/** Executes only after the independent transfer gate is enabled.
 * Rechecks booking status, release time and refunds before atomically
 * claiming execution. Completes provider lookup and validates transfer
 * evidence before recording success. Uncertain outcomes require
 * reconciliation and cannot automatically execute again.
 */

export async function attemptRelease(entitlementId: string): Promise<{ attempted: boolean; reason?: string; providerTransferId?: string }> {
  if (!isHostTransferExecutionEnabled()) {
    return { attempted: false, reason: "ENABLE_HOST_TRANSFER_EXECUTION is not set — real transfer creation is disabled" };
  }

  const row = await db.query(
    `SELECT hte.id, hte.booking_id, hte.host_id, hte.status, hte.amount_minor, hte.currency, hte.idempotency_key, hte.provider_transfer_id, hp.stripe_connect_account_id
     FROM host_transfer_entitlements hte
     JOIN host_profiles hp ON hp.id = hte.host_id
     JOIN bookings b ON b.id = hte.booking_id
     WHERE hte.id = $1
       AND b.status = 'confirmed'`,
    [entitlementId]
  );
  if (row.rows.length === 0) return { attempted: false, reason: "entitlement not found" };
  const e = row.rows[0];

  if (e.status !== "transfer_claimed") {
    return { attempted: false, reason: `entitlement is not in transfer_claimed status (was: ${e.status}) — refusing to transfer` };
  }
  if (e.provider_transfer_id) {
    return { attempted: false, reason: "a provider_transfer_id already exists for this entitlement — refusing to create a second transfer" };
  }
  if (!e.stripe_connect_account_id) {
    return { attempted: false, reason: "host has no connected Stripe account" };
  }

  const executionToken = crypto.randomUUID();
  const executionClaimed = await withTransaction(async (client) => {
    // Cancellation must use this same booking-first lock order.
    const booking = await client.query(
      `SELECT b.id, b.status
       FROM bookings b
       WHERE b.id = (
         SELECT booking_id FROM host_transfer_entitlements WHERE id = $1
       )
       FOR UPDATE OF b`,
      [entitlementId]
    );
    if (booking.rows.length !== 1 || booking.rows[0].status !== "confirmed") {
      return false;
    }

    const claim = await client.query(
      `UPDATE host_transfer_entitlements
       SET status = 'transfer_processing', updated_at = NOW(),
           execution_token = $2, execution_started_at = clock_timestamp(),
           execution_lease_expires_at = clock_timestamp() + INTERVAL '5 minutes'
       WHERE id = $1
         AND status = 'transfer_claimed'
         AND provider_transfer_id IS NULL
         AND scheduled_release_at <= clock_timestamp()
         AND NOT EXISTS (
           SELECT 1 FROM refunds r
           WHERE r.booking_id = host_transfer_entitlements.booking_id
             AND r.status IN ('pending', 'processing', 'succeeded')
         )
         AND NOT EXISTS (
           SELECT 1 FROM new_flow_refunds r
           WHERE r.booking_id = host_transfer_entitlements.booking_id
         )
       ${transferFinancialEligibility(3, 4, 5, 6)}
       RETURNING id`,
      [entitlementId, executionToken, e.amount_minor, e.currency, e.idempotency_key, e.stripe_connect_account_id]
    );
    return claim.rowCount === 1;
  });

  if (!executionClaimed) {
    return {
      attempted: false,
      reason: "transfer execution already started or release is no longer eligible",
    };
  }

  try {
    if (
      !Number.isSafeInteger(e.amount_minor) || e.amount_minor <= 0 ||
      typeof e.currency !== "string" || !/^[a-zA-Z]{3}$/.test(e.currency.trim()) ||
      typeof e.stripe_connect_account_id !== "string" ||
      !e.stripe_connect_account_id.startsWith("acct_")
    ) {
      throw new Error("Invalid expected transfer details");
    }

    let reconciled: Stripe.Transfer | null = null;
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    let lookupComplete = false;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = await stripe.transfers.list({
        destination: e.stripe_connect_account_id,
        limit: 100,
        ...(cursor ? { starting_after: cursor } : {}),
      });
      if (!Array.isArray(page.data) || typeof page.has_more !== "boolean") {
        throw new Error("Incomplete transfer lookup response");
      }
      for (const candidate of page.data) {
        if (candidate.metadata?.host_entitlement_id === entitlementId) {
          if (reconciled) throw new Error("Duplicate transfers match this entitlement");
          reconciled = candidate;
        }
      }
      if (!page.has_more) {
        lookupComplete = true;
        break;
      }
      const nextCursor = page.data.at(-1)?.id;
      if (!nextCursor || seenCursors.has(nextCursor)) {
        throw new Error("Incomplete or repeating transfer pagination cursor");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    if (!lookupComplete) throw new Error("Transfer pagination limit reached");
    const ownership = await db.query(
      `SELECT id FROM host_transfer_entitlements
       WHERE id = $1 AND status = 'transfer_processing'
         AND execution_token = $2 AND provider_transfer_id IS NULL
         AND execution_lease_expires_at > clock_timestamp()
         ${transferFinancialEligibility(3, 4, 5, 6)}`,
      [entitlementId, executionToken, e.amount_minor, e.currency, e.idempotency_key, e.stripe_connect_account_id]
    );
    if (ownership.rowCount !== 1) throw new Error("Transfer execution lease is no longer active");
    const transfer = reconciled ?? await withHostTransferProviderLock({
      entitlementId, bookingId: e.booking_id, hostId: e.host_id,
      executionToken, amountMinor: e.amount_minor, currency: e.currency,
      idempotencyKey: e.idempotency_key, destination: e.stripe_connect_account_id,
    }, () => {
      if (!isHostTransferExecutionEnabled()) {
        throw new Error("Transfer execution disabled before provider creation");
      }
      return stripe.transfers.create(
      {
        amount: e.amount_minor,
        currency: e.currency.trim().toLowerCase(),
        destination: e.stripe_connect_account_id,
        metadata: { host_entitlement_id: entitlementId },
      },
      { idempotencyKey: e.idempotency_key, timeout: 20000, maxNetworkRetries: 0 }
    );
    });

    const destination = typeof transfer.destination === "string"
      ? transfer.destination
      : transfer.destination?.id;
    if (
      typeof transfer.id !== "string" || !/^tr_[a-zA-Z0-9_]+$/.test(transfer.id) ||
      transfer.amount !== e.amount_minor ||
      typeof transfer.currency !== "string" ||
      transfer.currency.toLowerCase() !== e.currency.trim().toLowerCase() ||
      destination !== e.stripe_connect_account_id ||
      transfer.metadata?.host_entitlement_id !== entitlementId ||
      transfer.reversed !== false || transfer.amount_reversed !== 0
    ) {
      throw new Error("Stripe transfer evidence does not match the entitlement");
    }

    const recorded = await db.query(
      `UPDATE host_transfer_entitlements
       SET status = 'transfer_created', provider_transfer_id = $2, updated_at = NOW(),
           execution_token = NULL, execution_lease_expires_at = NULL
       WHERE id = $1 AND status = 'transfer_processing'
         AND provider_transfer_id IS NULL AND execution_token = $3
         AND execution_lease_expires_at > clock_timestamp()
         ${transferFinancialEligibility(4, 5, 6, 7)}
       RETURNING id`,
      [entitlementId, transfer.id, executionToken, e.amount_minor, e.currency, e.idempotency_key, e.stripe_connect_account_id]
    );
    if (recorded.rowCount !== 1) {
      throw new Error("Transfer outcome could not be recorded");
    }
    return { attempted: true, providerTransferId: transfer.id };
  } catch (error) {
    await db.query(
      `UPDATE host_transfer_entitlements
       SET status = 'transfer_reconciliation_required', updated_at = NOW(),
           execution_lease_expires_at = NULL
       WHERE id = $1 AND status = 'transfer_processing' AND execution_token = $2`,
      [entitlementId, executionToken]
    );
    return {
      attempted: true,
      reason: "Transfer outcome requires reconciliation: " + (error as Error).message,
    };
  }
}
