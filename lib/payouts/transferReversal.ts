import type Stripe from "stripe";
import { db } from "../db";
import { reversalFinancialEligibility, withTransferReversalProviderLock } from "./withTransferReversalProviderLock";
import crypto from "crypto";
import { stripe } from "../payments/stripeClient";
import { isTransferReversalExecutionEnabled } from "../config/featureFlags";

/**
 * Records a reversal request (refund or dispute occurring after a real
 * transfer_created entitlement) and its eventual, provider-confirmed
 * outcome. Deliberately two-step: requestReversal() records intent only;
 * confirmReversal() may only be called once real Stripe evidence exists
 * (a webhook or a checked API response), never merely because a request
 * was made — the governing rule from the accepted design.
 */

export async function requestReversal(entitlementId: string, amountMinor: number, reason: "refund" | "dispute") {
  const idempotencyKey = crypto.createHash("sha256").update(`transfer-reversal:${entitlementId}:${reason}:${amountMinor}`).digest("hex");
  const result = await db.query(
    `INSERT INTO host_transfer_reversals (entitlement_id, amount_minor, reason, status, idempotency_key)
     VALUES ($1, $2, $3, 'reversal_requested', $4)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [entitlementId, amountMinor, reason, idempotencyKey]
  );
  return result.rows[0]?.id ?? null;
}

/** Only ever called after genuine, confirmed Stripe evidence — a real
 *  transfer-reversal object ID from a checked API response or webhook.
 *  Never called merely because requestReversal() succeeded. */
export async function confirmReversal(reversalId: string, providerReversalId: string) {
  await db.query(
    `UPDATE host_transfer_reversals SET status = 'reversal_confirmed', provider_reversal_id = $2, confirmed_at = NOW() WHERE id = $1 AND status IN ('reversal_requested', 'reversal_processing')`,
    [reversalId, providerReversalId]
  );
}

/** Failed reversal (e.g. insufficient connected-account balance) —
 *  requires administrator alerting per the accepted design; alerting
 *  itself is wired at the call site (the future cron/worker), not here,
 *  since this module's job is pure data recording. */
export async function markReversalFailed(reversalId: string) {
  await db.query(`UPDATE host_transfer_reversals SET status = 'reversal_failed' WHERE id = $1`, [reversalId]);
}

export async function listReversalsForEntitlement(entitlementId: string) {
  const result = await db.query(
    `SELECT id, amount_minor, reason, status, provider_reversal_id, requested_at, confirmed_at
     FROM host_transfer_reversals WHERE entitlement_id = $1 ORDER BY requested_at ASC`,
    [entitlementId]
  );
  return result.rows;
}

/**
 * Batch 9B-1: the real Stripe SDK call for a reversal, distinct from
 * requestReversal()/confirmReversal() above (which remain pure DB
 * functions — this is the one place that actually calls Stripe).
 * Requires an already-`reversal_requested` row and its entitlement's
 * real provider_transfer_id — the transfer that's actually being
 * reversed. Uses transferReversals.create() (a reversal of a specific
 * transfer object) with a deterministic idempotency key derived from the
 * reversal row's own id, mirroring every other financial call in this
 * batch.
 *
 * On success, calls confirmReversal() with the real reversal ID Stripe
 * returned — never marks confirmed without that real object in hand. On
 * a Stripe-side failure (e.g. insufficient connected-account balance,
 * the exact risk the accepted design's audit identified), calls
 * markReversalFailed() instead — this failure path is exactly why the
 * design requires administrator alerting, wired at the caller (the
 * future release-worker/cron), not duplicated here.
 */

export async function executeReversal(reversalId: string): Promise<{ attempted: boolean; reason?: string; providerReversalId?: string }> {
  if (!isTransferReversalExecutionEnabled()) {
    return {
      attempted: false,
      reason: "ENABLE_TRANSFER_REVERSAL_EXECUTION is not set; reversal execution is disabled",
    };
  }

  const row = await db.query(
    `SELECT r.id, r.status, r.amount_minor, r.idempotency_key, r.entitlement_id,
            hte.booking_id, hte.host_id, hte.provider_transfer_id, hte.currency, hte.amount_minor AS original_amount_minor,
            hp.stripe_connect_account_id
     FROM host_transfer_reversals r
     JOIN host_transfer_entitlements hte ON hte.id = r.entitlement_id
     JOIN host_profiles hp ON hp.id = hte.host_id
     WHERE r.id = $1`,
    [reversalId]
  );
  if (row.rows.length === 0) return { attempted: false, reason: "reversal not found" };
  const r = row.rows[0];

  if (r.status !== "reversal_requested") {
    return { attempted: false, reason: `reversal is not in reversal_requested status (was: ${r.status}) — refusing to execute` };
  }
  if (!r.provider_transfer_id) {
    return { attempted: false, reason: "the entitlement has no provider_transfer_id — nothing to reverse yet" };
  }

  // Claim before contacting Stripe. An uncertain execution is never
  // returned to reversal_requested for an automatic retry.
  const executionToken = crypto.randomUUID();
  const claim = await db.query(
    `UPDATE host_transfer_reversals
     SET status = 'reversal_processing', execution_token = $2,
         execution_started_at = clock_timestamp(),
         execution_lease_expires_at = clock_timestamp() + INTERVAL '5 minutes'
     WHERE id = $1
       AND status = 'reversal_requested'
       AND provider_reversal_id IS NULL
       ${reversalFinancialEligibility(3, 4, 5, 6, 7)}
     RETURNING id`,
    [reversalId, executionToken, r.amount_minor, r.idempotency_key, r.provider_transfer_id, r.currency, r.stripe_connect_account_id]
  );
  if (claim.rowCount !== 1) {
    return { attempted: false, reason: "reversal already claimed or no longer eligible" };
  }

  try {
    let reconciled: Stripe.TransferReversal | undefined;
    let startingAfter: string | undefined;
    const seenCursors = new Set<string>();

    for (let pageNumber = 0; ; pageNumber++) {
      if (pageNumber >= 100) throw new Error("Reversal pagination review limit reached");
      const page = await stripe.transfers.listReversals(
        r.provider_transfer_id,
        { limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) }
      );
      if (!Array.isArray(page.data) || typeof page.has_more !== "boolean") {
        throw new Error("Invalid reversal pagination response");
      }
      const matches = page.data.filter(
        item => item.metadata?.host_reversal_id === reversalId
      );
      if (matches.length > 1 || (matches.length === 1 && reconciled)) {
        throw new Error("Multiple matching transfer reversals");
      }
      if (matches.length === 1) reconciled = matches[0];
      if (!page.has_more) break;
      const lastId = page.data[page.data.length - 1]?.id;
      if (!lastId || seenCursors.has(lastId)) {
        throw new Error("Incomplete reversal pagination");
      }
      seenCursors.add(lastId);
      startingAfter = lastId;
    }

    const original = await stripe.transfers.retrieve(r.provider_transfer_id);
    const destination = typeof original.destination === "string"
      ? original.destination : original.destination?.id;
    const expectedReversedMinor = reconciled ? r.amount_minor : 0;
    if (original.id !== r.provider_transfer_id ||
        !Number.isSafeInteger(r.original_amount_minor) || r.original_amount_minor <= 0 ||
        original.amount !== r.original_amount_minor ||
        original.currency?.toLowerCase() !== r.currency.trim().toLowerCase() ||
        destination !== r.stripe_connect_account_id ||
        original.metadata?.host_entitlement_id !== r.entitlement_id ||
        !Number.isSafeInteger(original.amount_reversed) ||
        original.amount_reversed !== expectedReversedMinor ||
        original.reversed !== (expectedReversedMinor === original.amount) ||
        (!reconciled && original.amount - original.amount_reversed < r.amount_minor)) {
      throw new Error("Original transfer evidence or reversal total requires review");
    }

    const ownership = await db.query(
      `SELECT id FROM host_transfer_reversals
       WHERE id = $1 AND status = 'reversal_processing'
         AND execution_token = $2 AND provider_reversal_id IS NULL
         AND execution_lease_expires_at > clock_timestamp()
         ${reversalFinancialEligibility(3, 4, 5, 6, 7)}`,
      [reversalId, executionToken, r.amount_minor, r.idempotency_key, r.provider_transfer_id, r.currency, r.stripe_connect_account_id]
    );
    if (ownership.rowCount !== 1) throw new Error("Reversal execution lease is no longer active");
    const reversal = reconciled ?? await withTransferReversalProviderLock({
      reversalId, entitlementId: r.entitlement_id,
      bookingId: r.booking_id, hostId: r.host_id, executionToken,
      amountMinor: r.amount_minor, originalAmountMinor: r.original_amount_minor,
      currency: r.currency, idempotencyKey: r.idempotency_key,
      providerTransferId: r.provider_transfer_id,
      destination: r.stripe_connect_account_id,
    }, () => {
      if (!isTransferReversalExecutionEnabled()) {
        throw new Error("Reversal execution disabled before provider creation");
      }
      return stripe.transfers.createReversal(
      r.provider_transfer_id,
      { amount: r.amount_minor, metadata: { host_reversal_id: reversalId } },
      { idempotencyKey: r.idempotency_key, timeout: 20000, maxNetworkRetries: 0 }
    );
    });
    const transferId = typeof reversal.transfer === "string"
      ? reversal.transfer
      : reversal.transfer?.id;
    if (
      !/^trr_[A-Za-z0-9_]+$/.test(reversal.id) ||
      transferId !== r.provider_transfer_id ||
      !Number.isSafeInteger(r.amount_minor) ||
      r.amount_minor <= 0 ||
      reversal.amount !== r.amount_minor ||
      typeof reversal.currency !== "string" ||
      reversal.currency.toLowerCase() !== r.currency.trim().toLowerCase() ||
      reversal.metadata?.host_reversal_id !== reversalId
    ) {
      throw new Error("Transfer reversal payment details mismatch");
    }
    const recorded = await db.query(
      `UPDATE host_transfer_reversals
       SET status = 'reversal_confirmed', provider_reversal_id = $2,
           confirmed_at = NOW(), execution_token = NULL,
           execution_lease_expires_at = NULL
       WHERE id = $1 AND status = 'reversal_processing'
         AND execution_token = $3 AND provider_reversal_id IS NULL
         AND execution_lease_expires_at > clock_timestamp()
         ${reversalFinancialEligibility(4, 5, 6, 7, 8)}
       RETURNING id`,
      [reversalId, reversal.id, executionToken, r.amount_minor, r.idempotency_key, r.provider_transfer_id, r.currency, r.stripe_connect_account_id]
    );
    if (recorded.rowCount !== 1) throw new Error("Reversal outcome could not be recorded");
    return { attempted: true, providerReversalId: reversal.id };
  } catch (error) {
    await db.query(
      `UPDATE host_transfer_reversals
       SET status = 'reversal_reconciliation_required', execution_lease_expires_at = NULL
       WHERE id = $1 AND status = 'reversal_processing' AND execution_token = $2`,
      [reversalId, executionToken]
    );
    return {
      attempted: true,
      reason: "Reversal outcome requires reconciliation: " + (error as Error).message,
    };
  }
}


/**
 * Read-only review of uncertain outcomes and processing claims.
 * A processing claim may still be active; listing never authorises retry.
 * Never contacts Stripe or changes reversal state.
 */
export async function listTransferReversalsForReview(limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Invalid reversal review limit");
  }
  const result = await db.query(
    `SELECT
       r.id AS reversal_id,
       r.entitlement_id,
       hte.booking_id,
       hte.provider_transfer_id,
       r.provider_reversal_id,
       r.amount_minor,
       hte.currency,
       r.reason,
       r.status,
       r.requested_at
     FROM host_transfer_reversals r
     JOIN host_transfer_entitlements hte ON hte.id = r.entitlement_id
     WHERE r.status IN ('reversal_processing', 'reversal_reconciliation_required')
     ORDER BY r.requested_at ASC, r.id ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}
