import { hasNewFlowRefundAuthorization } from "./newFlowRefundAuthorization";
import { db, withTransaction } from "../db";
import { isNewFlowRefundReconciliationEnabled } from "../config/featureFlags";
import {
  findNewFlowStripeRefund,
  verifyNewFlowStripeRefund,
} from "./newFlowStripeRefundVerification";

const eligibleRefundSql = `
  SELECT r.booking_id, r.payment_attempt_id, r.amount_minor, r.currency,
         r.claim_token, r.updated_at::text AS refund_version,
         r.execution_started_at::text AS execution_version,
         p.provider_payment_intent_id,
         p.amount_minor AS payment_amount_minor, p.currency AS payment_currency
  FROM new_flow_refunds r
  JOIN payment_attempts p
    ON p.id = r.payment_attempt_id AND p.booking_id = r.booking_id
  JOIN bookings b ON b.id = r.booking_id
  WHERE r.id = $1 AND r.status = 'processing'
    AND r.reconciliation_required = TRUE
    AND r.execution_started_at IS NOT NULL
    AND r.provider_refund_id IS NULL
    AND r.claim_token IS NOT NULL AND r.lease_expires_at IS NULL
    AND b.status = 'cancelled'
    AND b.payment_flow_version = 'separate_charges_delayed_v1'
    AND p.status = 'succeeded'
    AND r.amount_minor > 0 AND r.amount_minor <= p.amount_minor
    AND LOWER(r.currency) = LOWER(p.currency)`;

/** Records verified existing success only. Never creates refunds or permits replay. */
export async function reconcileNewFlowRefund(
  refundId: string
): Promise<{ recorded: boolean; reason: string }> {
  if (!isNewFlowRefundReconciliationEnabled()) {
    return { recorded: false, reason: "Refund reconciliation is disabled" };
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(refundId)) {
    return { recorded: false, reason: "Invalid refund identifier" };
  }
  const result = await db.query(eligibleRefundSql, [refundId]);
  const refund = result.rows[0];
  if (result.rows.length !== 1 ||
      !Number.isSafeInteger(refund.amount_minor) ||
      !Number.isSafeInteger(refund.payment_amount_minor) ||
      !/^[A-Za-z]{3}$/.test(refund.currency ?? "") ||
      !/^pi_[A-Za-z0-9_]+$/.test(refund.provider_payment_intent_id ?? "")) {
    return { recorded: false, reason: "Refund not eligible for reconciliation" };
  }

  const lookup = await findNewFlowStripeRefund(
    refundId, refund.provider_payment_intent_id, refund.amount_minor, refund.currency
  );
  if (lookup.outcome !== "found") {
    return {
      recorded: false,
      reason: lookup.outcome === "unknown" ? lookup.reason :
        "No matching refund found; execution remains blocked",
    };
  }
  const verification = await verifyNewFlowStripeRefund(
    lookup.refundId, refund.provider_payment_intent_id,
    refund.amount_minor, refund.currency, refundId
  );
  if (verification.outcome !== "succeeded") {
    return { recorded: false, reason: "Refund verification: " + verification.outcome };
  }

  const recorded = await withTransaction(async (client) => {
    await client.query(
      "SELECT id FROM bookings WHERE id = $1 FOR UPDATE", [refund.booking_id]
    );
    await client.query(
      "SELECT id FROM payment_attempts WHERE id = $1 FOR UPDATE",
      [refund.payment_attempt_id]
    );
    await client.query(
      "SELECT id FROM new_flow_refunds WHERE id = $1 FOR UPDATE", [refundId]
    );
    const fresh = await client.query(eligibleRefundSql, [refundId]);
    if (!isNewFlowRefundReconciliationEnabled() || fresh.rows.length !== 1) return false;
    const current = fresh.rows[0];
    for (const key of [
      "booking_id", "payment_attempt_id", "amount_minor", "currency", "claim_token",
      "refund_version", "execution_version", "provider_payment_intent_id",
      "payment_amount_minor", "payment_currency"
    ]) {
      if (current[key] !== refund[key]) return false;
    }
    if (!await hasNewFlowRefundAuthorization(client, refundId)) return false;
    const completion = await client.query(
      `UPDATE new_flow_refunds
       SET status = 'succeeded', provider_refund_id = $3,
           claim_token = NULL, lease_expires_at = NULL,
           reconciliation_required = FALSE, last_error = NULL, updated_at = NOW()
       WHERE id = $1 AND claim_token = $2
         AND status = 'processing' AND reconciliation_required = TRUE
         AND provider_refund_id IS NULL AND lease_expires_at IS NULL
       RETURNING id`,
      [refundId, refund.claim_token, verification.refundId]
    );
    if (completion.rowCount !== 1) return false;
    await client.query(
      `INSERT INTO audit_log(action, object_type, object_id, previous_state, new_state)
       VALUES ('new_flow_refund_reconciled', 'new_flow_refund', $1, $2::jsonb, $3::jsonb)`,
      [refundId, JSON.stringify({ status: "processing", reconciliationRequired: true }),
       JSON.stringify({
         status: "succeeded", bookingId: refund.booking_id,
         paymentAttemptId: refund.payment_attempt_id,
         amountMinor: refund.amount_minor, currency: refund.currency,
         providerPaymentIntentId: refund.provider_payment_intent_id,
         providerRefundId: verification.refundId
       })]
    );
    return true;
  });
  return {
    recorded,
    reason: recorded ? "Reconciled Stripe refund success recorded" :
      "Refund reconciliation no longer permitted",
  };
}
