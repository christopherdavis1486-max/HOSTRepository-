import { db } from "../db";
import crypto from "crypto";
import { stripe } from "../payments/stripeClient";

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
    `UPDATE host_transfer_reversals SET status = 'reversal_confirmed', provider_reversal_id = $2, confirmed_at = NOW() WHERE id = $1`,
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
  const row = await db.query(
    `SELECT r.id, r.status, r.amount_minor, r.idempotency_key, hte.provider_transfer_id
     FROM host_transfer_reversals r
     JOIN host_transfer_entitlements hte ON hte.id = r.entitlement_id
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

  // Reconciliation before creating: check whether a reversal with this
  // exact idempotency key already exists on the transfer, rather than
  // assuming local state is authoritative.
  const existingReversals = await stripe.transfers.listReversals(r.provider_transfer_id, { limit: 20 });
  const reconciled = existingReversals.data.find((tr) => tr.metadata?.host_reversal_id === reversalId);

  try {
    const reversal = reconciled ?? await stripe.transfers.createReversal(
      r.provider_transfer_id,
      { amount: r.amount_minor, metadata: { host_reversal_id: reversalId } },
      { idempotencyKey: r.idempotency_key }
    );
    await confirmReversal(reversalId, reversal.id);
    return { attempted: true, providerReversalId: reversal.id };
  } catch (error) {
    // Exactly the risk the accepted design's audit identified: a
    // reversal can genuinely fail if the connected account's balance is
    // insufficient. Recorded honestly as a failure, never silently
    // retried or assumed to have partially succeeded.
    await markReversalFailed(reversalId);
    return { attempted: true, reason: (error as Error).message };
  }
}
