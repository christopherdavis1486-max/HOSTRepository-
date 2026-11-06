import type Stripe from "stripe";
import { db, withTransaction } from "../db";
import { hashToBigint } from "../utils/advisoryLock";
import { reversalFinancialEligibility } from "./withTransferReversalProviderLock";

const reversalRecoverySnapshotSql = `
  SELECT r.*, to_jsonb(r) AS reversal_snapshot, e.currency,
         e.provider_transfer_id, e.amount_minor AS transfer_amount,
         e.booking_id, e.host_id, hp.stripe_connect_account_id,
         to_jsonb(e) AS entitlement_snapshot,
         to_jsonb(b) AS booking_snapshot,
         to_jsonb(pc) AS price_snapshot,
         to_jsonb(p) AS payment_snapshot,
         (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id)
          FROM new_flow_refunds f WHERE f.booking_id = b.id) AS refund_snapshot,
         (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id)
          FROM audit_log a WHERE a.object_id = b.id) AS audit_snapshot
  FROM host_transfer_reversals r
  JOIN host_transfer_entitlements e ON e.id = r.entitlement_id
  JOIN bookings b ON b.id = e.booking_id AND b.host_id = e.host_id
  JOIN booking_price_components pc ON pc.booking_id = b.id
  JOIN payment_attempts p ON p.booking_id = b.id
  JOIN host_profiles hp ON hp.id = e.host_id
  WHERE r.id = $1 AND r.status = 'reversal_reconciliation_required'
    AND r.provider_reversal_id IS NULL AND r.confirmed_at IS NULL
    AND r.execution_lease_expires_at IS NULL
    AND e.status = 'transfer_created'
    AND b.payment_flow_version = 'separate_charges_delayed_v1'
`;

function authorizationQuery(reversalId: string, row: any) {
  return {
    text: `SELECT id FROM host_transfer_reversals WHERE id = $1
           ${reversalFinancialEligibility(2, 3, 4, 5, 6)}`,
    values: [reversalId, row.amount_minor, row.idempotency_key,
             row.provider_transfer_id, row.currency, row.stripe_connect_account_id],
  };
}

import { stripe } from "../payments/stripeClient";
import { isTransferReversalReconciliationEnabled } from "../config/featureFlags";

/** Records verified existing reversals only; never creates or retries them. */
export async function reconcileTransferReversal(
  reversalId: string
): Promise<{ recorded: boolean; reason: string }> {
  if (!isTransferReversalReconciliationEnabled()) {
    return { recorded: false, reason: "Reversal reconciliation is disabled" };
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reversalId)) {
    return { recorded: false, reason: "Invalid reversal identifier" };
  }
  const result = await db.query(
    reversalRecoverySnapshotSql,
    [reversalId]
  );
  if (result.rows.length !== 1) {
    return { recorded: false, reason: "Reversal not eligible for reconciliation" };
  }
  const r = result.rows[0];
  if (!Number.isSafeInteger(r.amount_minor) || r.amount_minor <= 0 ||
      !Number.isSafeInteger(r.transfer_amount) || r.amount_minor > r.transfer_amount ||
      typeof r.currency !== "string" || !/^[A-Za-z]{3}$/.test(r.currency.trim()) ||
      !/^tr_[A-Za-z0-9_]+$/.test(r.provider_transfer_id ?? "")) {
    return { recorded: false, reason: "Invalid stored reversal details" };
  }
  if ((await db.query(authorizationQuery(reversalId, r))).rowCount !== 1) {
    return { recorded: false, reason: "Reversal financial authorization requires review" };
  }
  try {
    let found: Stripe.TransferReversal | undefined;
    let cursor: string | undefined;
    const seen = new Set<string>();
    let complete = false;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = await stripe.transfers.listReversals(
        r.provider_transfer_id,
        { limit: 100, ...(cursor ? { starting_after: cursor } : {}) }
      );
      if (!Array.isArray(page.data) || typeof page.has_more !== "boolean") {
        throw new Error("Invalid reversal pagination metadata");
      }
      for (const candidate of page.data) {
        if (candidate.metadata?.host_reversal_id === reversalId) {
          if (found) throw new Error("Multiple matching reversals");
          found = candidate;
        }
      }
      if (!page.has_more) { complete = true; break; }
      const next = page.data.at(-1)?.id;
      if (!next || seen.has(next)) throw new Error("Incomplete reversal pagination");
      seen.add(next);
      cursor = next;
    }
    if (!complete) throw new Error("Reversal pagination limit reached");
    if (!found) {
      return { recorded: false, reason: "No matching reversal found; execution remains blocked" };
    }
    const reversal = await stripe.transfers.retrieveReversal(r.provider_transfer_id, found.id);
    const transferId = typeof reversal.transfer === "string"
      ? reversal.transfer : reversal.transfer?.id;
    if (!/^trr_[A-Za-z0-9_]+$/.test(reversal.id) || reversal.id !== found.id ||
        transferId !== r.provider_transfer_id ||
        reversal.amount !== r.amount_minor ||
        reversal.currency?.toLowerCase() !== r.currency.trim().toLowerCase() ||
        reversal.metadata?.host_reversal_id !== reversalId) {
      throw new Error("Reversal evidence mismatch");
    }
    const completion = await withTransaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [hashToBigint(r.booking_id)]);
      await client.query("SELECT id FROM bookings WHERE id = $1 FOR UPDATE", [r.booking_id]);
      await client.query("SELECT booking_id FROM booking_price_components WHERE booking_id = $1 FOR SHARE", [r.booking_id]);
      await client.query("SELECT id FROM payment_attempts WHERE booking_id = $1 ORDER BY attempt_number FOR SHARE", [r.booking_id]);
      await client.query("SELECT id FROM host_transfer_entitlements WHERE id = $1 FOR UPDATE", [r.entitlement_id]);
      await client.query("SELECT id FROM host_transfer_reversals WHERE entitlement_id = $1 ORDER BY id FOR UPDATE", [r.entitlement_id]);
      await client.query("SELECT id FROM new_flow_refunds WHERE booking_id = $1 ORDER BY id FOR SHARE", [r.booking_id]);
      await client.query("SELECT id FROM audit_log WHERE object_id = $1 ORDER BY id FOR SHARE NOWAIT", [r.booking_id]);
      await client.query("SELECT id FROM host_profiles WHERE id = $1 FOR SHARE", [r.host_id]);
      const rows = (await client.query(reversalRecoverySnapshotSql, [reversalId])).rows;
      if (rows.length !== 1) return false;
      const current = rows[0];
      const fields = [
        "reversal_snapshot", "entitlement_id", "amount_minor", "execution_token", "idempotency_key",
        "currency", "provider_transfer_id", "transfer_amount", "booking_id", "host_id",
        "stripe_connect_account_id", "entitlement_snapshot", "booking_snapshot",
        "price_snapshot", "payment_snapshot", "refund_snapshot", "audit_snapshot"
      ];
      if (fields.some(key => JSON.stringify(current[key]) !== JSON.stringify(r[key]))) return false;
      if ((await client.query(authorizationQuery(reversalId, current))).rowCount !== 1) return false;
      if (!isTransferReversalReconciliationEnabled()) return false;
      const updated = await client.query(
      `UPDATE host_transfer_reversals r
       SET status = 'reversal_confirmed', provider_reversal_id = $2, confirmed_at = NOW(),
           execution_token = NULL, execution_lease_expires_at = NULL
       WHERE r.id = $1 AND r.status = 'reversal_reconciliation_required'
         AND r.provider_reversal_id IS NULL AND r.confirmed_at IS NULL
         AND r.execution_lease_expires_at IS NULL
         AND r.execution_token IS NOT DISTINCT FROM $8::uuid
         AND r.amount_minor = $3 AND r.entitlement_id = $4
         AND EXISTS (
           SELECT 1 FROM host_transfer_entitlements e
           JOIN bookings b ON b.id = e.booking_id AND b.host_id = e.host_id
           WHERE e.id = r.entitlement_id AND e.status = 'transfer_created'
             AND e.provider_transfer_id = $5 AND e.currency = $6
             AND e.amount_minor = $7
             AND b.payment_flow_version = 'separate_charges_delayed_v1'
         )
         AND NOT EXISTS (
           SELECT 1 FROM host_transfer_reversals other
           WHERE other.id <> r.id AND other.provider_reversal_id = $2
         )
       RETURNING r.id`,
      [reversalId, reversal.id, r.amount_minor, r.entitlement_id,
       r.provider_transfer_id, r.currency, r.transfer_amount, r.execution_token]
      );
      return updated.rowCount === 1;
    });
    return {
      recorded: completion,
      reason: completion
        ? "Verified reversal recovered" : "Reversal recovery no longer permitted",
    };
  } catch (error) {
    return {
      recorded: false,
      reason: error instanceof Error ? error.message : "Unknown reversal evidence",
    };
  }
}
