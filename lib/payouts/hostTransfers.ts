import { db } from "../db";
import crypto from "crypto";
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

export type EntitlementStatus = "entitled" | "release_due" | "transfer_claimed" | "transfer_created" | "transfer_failed" | "cancelled_before_transfer";

/** Called only after a real payment_attempts row shows status='succeeded'
 *  — never at charge time, never automatically as a side effect of a
 *  charge (unlike the legacy destination-charge path this deliberately
 *  does NOT replicate). */
export async function createEntitlement(input: {
  bookingId: string; hostId: string; amountMinor: number; taxAmountMinor: number | null;
  currency: string; scheduledReleaseAt: Date;
}) {
  const idempotencyKey = crypto.createHash("sha256").update(`host-transfer-entitlement:${input.bookingId}`).digest("hex");
  const result = await db.query(
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
     RETURNING id`,
    [entitlementId, workerId]
  );
  return result.rows.length > 0;
}

/**
 * Batch 9B-1: real Stripe SDK logic, replacing the prior deliberate
 * stub. The flag check remains the absolute first thing this function
 * does — before any other logic, any database read, or any Stripe call
 * — exactly as it was in the stub version, now simply followed by real
 * work instead of a thrown placeholder error.
 *
 * Only ever called on an entitlement already moved to
 * 'transfer_claimed' by claimEntitlement()'s atomic claim — this
 * function does not re-claim or re-check the release-due invariants
 * itself; that separation of concerns (find/claim vs. execute) already
 * existed in the stub and is unchanged.
 */
export async function attemptRelease(entitlementId: string): Promise<{ attempted: boolean; reason?: string; providerTransferId?: string }> {
  if (!isHostTransferExecutionEnabled()) {
    return { attempted: false, reason: "ENABLE_HOST_TRANSFER_EXECUTION is not set — real transfer creation is disabled" };
  }

  const row = await db.query(
    `SELECT hte.id, hte.status, hte.amount_minor, hte.currency, hte.idempotency_key, hte.provider_transfer_id, hp.stripe_connect_account_id
     FROM host_transfer_entitlements hte
     JOIN host_profiles hp ON hp.id = hte.host_id
     WHERE hte.id = $1`,
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

  // Reconciliation before creating: ask Stripe directly whether a
  // transfer with this exact idempotency key already exists, rather than
  // assuming our own local state is authoritative — the same discipline
  // already established in lib/payments/refund.ts's initiateRefund().
  const existingTransfers = await stripe.transfers.list({ destination: e.stripe_connect_account_id, limit: 20 });
  const reconciled = existingTransfers.data.find((t) => t.metadata?.host_entitlement_id === entitlementId);

  let transfer;
  if (reconciled) {
    transfer = reconciled;
  } else {
    try {
      transfer = await stripe.transfers.create(
        {
          amount: e.amount_minor,
          currency: e.currency.toLowerCase(),
          destination: e.stripe_connect_account_id,
          metadata: { host_entitlement_id: entitlementId },
        },
        { idempotencyKey: e.idempotency_key }
      );
    } catch (error) {
      await db.query(`UPDATE host_transfer_entitlements SET status = 'transfer_failed', updated_at = NOW() WHERE id = $1`, [entitlementId]);
      return { attempted: true, reason: (error as Error).message };
    }
  }

  await db.query(
    `UPDATE host_transfer_entitlements SET status = 'transfer_created', provider_transfer_id = $2, updated_at = NOW() WHERE id = $1`,
    [entitlementId, transfer.id]
  );
  return { attempted: true, providerTransferId: transfer.id };
}
