import type Stripe from "stripe";
import { db, withTransaction } from "../db";
import { hashToBigint } from "../utils/advisoryLock";

const recoverySnapshotSql = `
  SELECT e.*, e.updated_at::text AS version,
         hp.stripe_connect_account_id,
         to_jsonb(b) AS booking_snapshot,
         to_jsonb(pc) AS price_snapshot,
         to_jsonb(p) AS payment_snapshot
  FROM host_transfer_entitlements e
  JOIN host_profiles hp ON hp.id = e.host_id
  JOIN bookings b ON b.id = e.booking_id AND b.host_id = e.host_id
  JOIN booking_price_components pc ON pc.booking_id = b.id
  JOIN payment_attempts p ON p.booking_id = b.id
  WHERE e.id = $1 AND e.status = 'transfer_reconciliation_required'
    AND e.provider_transfer_id IS NULL AND e.execution_lease_expires_at IS NULL
    AND b.payment_flow_version = 'separate_charges_delayed_v1'
    AND p.status = 'succeeded'
    AND p.provider_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'
    AND p.amount_minor = pc.guest_total_minor AND p.amount_minor > 0
    AND e.amount_minor = pc.host_payout_minor AND e.amount_minor > 0
    AND lower(trim(p.currency)) = lower(trim(pc.currency))
    AND lower(trim(e.currency)) = lower(trim(pc.currency))
    AND (SELECT COUNT(*) FROM payment_attempts other WHERE other.booking_id = b.id) = 1
`;

import { stripe } from "../payments/stripeClient";
import { isHostTransferReconciliationEnabled } from "../config/featureFlags";

/** Records verified existing money movement only.
 * Never creates transfers, resets execution state, or recovers active processing.
 */
export async function reconcileHostTransfer(
  entitlementId: string
): Promise<{ recorded: boolean; reason: string }> {
  if (!isHostTransferReconciliationEnabled()) {
    return { recorded: false, reason: "Transfer reconciliation is disabled" };
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entitlementId)) {
    return { recorded: false, reason: "Invalid entitlement identifier" };
  }
  const result = await db.query(
    recoverySnapshotSql,
    [entitlementId]
  );
  if (result.rows.length !== 1) {
    return { recorded: false, reason: "Transfer not eligible for reconciliation" };
  }
  const e = result.rows[0];
  if (!Number.isSafeInteger(e.amount_minor) || e.amount_minor <= 0 ||
      typeof e.currency !== "string" || !/^[A-Za-z]{3}$/.test(e.currency.trim()) ||
      !/^acct_[A-Za-z0-9_]+$/.test(e.stripe_connect_account_id ?? "")) {
    return { recorded: false, reason: "Invalid stored transfer details" };
  }

  try {
    let found: Stripe.Transfer | undefined;
    let cursor: string | undefined;
    const seen = new Set<string>();
    let complete = false;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = await stripe.transfers.list({
        destination: e.stripe_connect_account_id, limit: 100,
        ...(cursor ? { starting_after: cursor } : {}),
      });
      if (!Array.isArray(page.data) || typeof page.has_more !== "boolean") {
        throw new Error("Invalid transfer pagination metadata");
      }
      for (const candidate of page.data) {
        if (candidate.metadata?.host_entitlement_id === entitlementId) {
          if (found) throw new Error("Multiple matching transfers");
          found = candidate;
        }
      }
      if (!page.has_more) { complete = true; break; }
      const next = page.data.at(-1)?.id;
      if (!next || seen.has(next)) throw new Error("Incomplete transfer pagination");
      seen.add(next);
      cursor = next;
    }
    if (!complete) throw new Error("Transfer pagination limit reached");
    if (!found) {
      return { recorded: false, reason: "No matching transfer found; execution remains blocked" };
    }

    // Retrieve fresh evidence after the entire lookup has completed.
    const transfer = await stripe.transfers.retrieve(found.id);
    const destination = typeof transfer.destination === "string"
      ? transfer.destination : transfer.destination?.id;
    if (!/^tr_[A-Za-z0-9_]+$/.test(transfer.id) || transfer.id !== found.id ||
        transfer.amount !== e.amount_minor ||
        transfer.currency?.toLowerCase() !== e.currency.trim().toLowerCase() ||
        destination !== e.stripe_connect_account_id ||
        transfer.metadata?.host_entitlement_id !== entitlementId ||
        transfer.reversed !== false || transfer.amount_reversed !== 0) {
      throw new Error("Transfer evidence mismatch or reversal requires further review");
    }
    const recorded = await withTransaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [hashToBigint(e.booking_id)]);
      await client.query("SELECT id FROM bookings WHERE id = $1 FOR UPDATE", [e.booking_id]);
      await client.query("SELECT booking_id FROM booking_price_components WHERE booking_id = $1 FOR SHARE", [e.booking_id]);
      await client.query("SELECT id FROM payment_attempts WHERE booking_id = $1 ORDER BY attempt_number FOR SHARE", [e.booking_id]);
      await client.query("SELECT id FROM host_transfer_entitlements WHERE id = $1 FOR UPDATE", [entitlementId]);
      await client.query("SELECT id FROM host_profiles WHERE id = $1 FOR SHARE", [e.host_id]);
      const current = (await client.query(recoverySnapshotSql, [entitlementId])).rows[0];
      if (!current ||
          current.version !== e.version ||
          current.execution_token !== e.execution_token ||
          current.idempotency_key !== e.idempotency_key ||
          current.host_id !== e.host_id || current.booking_id !== e.booking_id ||
          current.amount_minor !== e.amount_minor || current.currency !== e.currency ||
          current.stripe_connect_account_id !== e.stripe_connect_account_id ||
          JSON.stringify(current.booking_snapshot) !== JSON.stringify(e.booking_snapshot) ||
          JSON.stringify(current.price_snapshot) !== JSON.stringify(e.price_snapshot) ||
          JSON.stringify(current.payment_snapshot) !== JSON.stringify(e.payment_snapshot)) {
        return false;
      }
      const duplicate = await client.query(
        "SELECT id FROM host_transfer_entitlements WHERE provider_transfer_id = $1 AND id <> $2",
        [transfer.id, entitlementId]
      );
      if (duplicate.rows.length) return false;
      if (!isHostTransferReconciliationEnabled()) return false;
      const updated = await client.query(
      `UPDATE host_transfer_entitlements e
       SET status = 'transfer_created', provider_transfer_id = $2, updated_at = NOW(),
           execution_token = NULL, execution_lease_expires_at = NULL
       WHERE e.id = $1 AND e.status = 'transfer_reconciliation_required'
         AND e.provider_transfer_id IS NULL AND e.execution_lease_expires_at IS NULL
         AND e.execution_token IS NOT DISTINCT FROM $8::uuid
         AND e.amount_minor = $3 AND e.currency = $4
         AND e.host_id = $5 AND e.booking_id = $6
         AND EXISTS (
           SELECT 1 FROM host_profiles hp JOIN bookings b ON b.host_id = hp.id
           WHERE hp.id = e.host_id AND b.id = e.booking_id
             AND hp.stripe_connect_account_id = $7
             AND b.payment_flow_version = 'separate_charges_delayed_v1'
         )
       RETURNING e.id`,
      [entitlementId, transfer.id, e.amount_minor, e.currency,
       e.host_id, e.booking_id, e.stripe_connect_account_id, e.execution_token]
      );
      return updated.rowCount === 1;
    });
    return {
      recorded,
      reason: recorded
        ? "Verified transfer recovered" : "Transfer recovery no longer permitted",
    };
  } catch (error) {
    return {
      recorded: false,
      reason: error instanceof Error ? error.message : "Unknown transfer evidence",
    };
  }
}
